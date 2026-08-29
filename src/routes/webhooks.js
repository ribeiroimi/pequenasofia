const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { supabase } = require('../db');
const { PLANOS, planoValido } = require('../lib/planos');
const { enviarAlertaAdmin } = require('../lib/alertas');

// Mapeia o nome da oferta configurada na Cakto para o nosso identificador
// interno de plano. AJUSTE os textos à esquerda para bater exatamente
// com o nome que você deu a cada oferta no painel da Cakto.
const NOME_OFERTA_PARA_PLANO = {
  'Pequena Sofia - Curioso': 'curioso',
  'Pequena Sofia - Pensador': 'pensador',
  'Pequena Sofia - Filosofo': 'filosofo',
};

function identificarPlano(payloadData) {
  const nomeOferta = payloadData?.offer?.name || '';
  // Retorna null (não 'curioso') quando o nome não bate com nada conhecido —
  // se mascarássemos com um fallback aqui, o handler de subscription_renewed
  // nunca saberia diferenciar "é realmente o Curioso" de "nome de oferta que
  // não reconhecemos", e um upgrade de plano passaria batido sem alerta.
  return NOME_OFERTA_PARA_PLANO[nomeOferta] || null;
}

// Normalização única de e-mail — usada em TODOS os pontos que tocam e-mail,
// senão "Fulano@Gmail.com" (Cakto) e "fulano@gmail.com" (login) viram
// duas contas diferentes.
function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Comparação em tempo constante — evita que um atacante descubra o secret
// byte a byte medindo o tempo de resposta.
function secretConfere(recebido) {
  const esperado = process.env.CAKTO_WEBHOOK_SECRET || '';
  const a = Buffer.from(String(recebido || ''));
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ------------------------------------------------------------------
// Idempotência "claim-first": tenta INSERIR o evento_id (chave primária)
// ANTES de processar. Se o insert falhar por duplicidade, outro worker
// já pegou (ou já processou) este evento — respondemos 200 sem repetir.
// Isso fecha a race condition do padrão "verificar → processar → marcar",
// em que dois reenvios simultâneos passavam pela verificação e
// creditavam o cliente em dobro.
// ------------------------------------------------------------------
async function reivindicarEvento(eventoId, eventoTipo) {
  const { error } = await supabase
    .from('webhook_eventos_processados')
    .insert({ evento_id: eventoId, evento_tipo: eventoTipo });
  if (!error) return true;               // conseguimos a "posse" do evento
  if (error.code === '23505') return false; // unique_violation → já processado/em processamento
  throw error;                            // outro erro de banco → deixa estourar (500 → Cakto reenvia)
}

// Se o processamento falhar DEPOIS de reivindicar, liberamos a marca
// para que o reenvio automático da Cakto possa tentar de novo.
async function liberarEvento(eventoId) {
  await supabase.from('webhook_eventos_processados').delete().eq('evento_id', eventoId);
}

async function buscarUsuarioPorEmail(email) {
  const { data } = await supabase.from('usuarios').select('*').eq('email', email).maybeSingle();
  return data;
}

// POST /webhooks/cakto
router.post('/cakto', async (req, res) => {
  const payload = req.body;

  // 1. valida a chave secreta configurada no painel de webhook da Cakto
  if (!secretConfere(payload.secret)) {
    console.warn('[webhook cakto] secret inválido recebido');
    return res.status(401).json({ erro: 'secret inválido' });
  }

  const evento = payload.event;
  const d = payload.data || {};
  const eventoId = d.id;

  if (!eventoId) return res.status(400).json({ erro: 'payload sem data.id' });

  // 2. idempotência — reivindica o evento ANTES de processar
  let reivindicado;
  try {
    reivindicado = await reivindicarEvento(eventoId, evento);
  } catch (err) {
    console.error('[webhook cakto] erro ao registrar evento', err.message);
    return res.status(500).json({ erro: 'falha ao registrar evento' });
  }
  if (!reivindicado) {
    return res.status(200).json({ ok: true, duplicado: true });
  }

  const email = normalizarEmail(d.customer?.email);
  const nome = d.customer?.name || 'Cliente';

  try {
    switch (evento) {
      case 'subscription_created': {
        // Todo cadastro novo começa OBRIGATORIAMENTE no plano Curioso,
        // independente de qual oferta o link levou — trava de segurança.
        if (!email) throw new Error('subscription_created sem e-mail do cliente');
        let usuario = await buscarUsuarioPorEmail(email);

        if (!usuario) {
          // Cria também o usuário no Supabase Auth, para que ele consiga
          // logar depois via magic link com este mesmo e-mail.
          const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
            email,
            email_confirm: true,
          });
          if (authErr) throw authErr;

          const trialFim = new Date();
          trialFim.setDate(trialFim.getDate() + 30);

          const { data: novoUsuario, error: insErr } = await supabase
            .from('usuarios')
            .insert({
              id: authUser.user.id,
              nome,
              email,
              plano_atual: 'curioso',
              status: 'ativo',
              trial_ativo: true,
              trial_fim: trialFim.toISOString().slice(0, 10),
              cakto_customer_email: email,
            })
            .select()
            .single();
          if (insErr) throw insErr;
          usuario = novoUsuario;
        }

        await creditarOuFalhar(usuario.id, PLANOS.curioso.creditos_mes, 'credito_mensal',
          'assinatura criada — ' + eventoId);
        break;
      }

      case 'subscription_renewed': {
        const usuario = await buscarUsuarioPorEmail(email);
        if (!usuario) { console.warn('[webhook] renovação para usuário inexistente:', email); break; }

        // Se a Cakto informar a oferta no payload da renovação e ela indicar
        // um plano diferente (caso de upgrade confirmado), atualizamos o
        // plano local ANTES de creditar — assim o crédito é do plano novo
        // e o saldo antigo é preservado (soma, nunca substitui).
        const nomeOfertaRecebido = d.offer?.name;
        const planoDoPayload = identificarPlano(d);

        // Ambiguidade real: a Cakto mandou um nome de oferta, mas não é
        // nenhum dos três configurados em NOME_OFERTA_PARA_PLANO. Sem
        // alerta, isso passa batido — o backend trata como renovação do
        // plano antigo, o cliente paga o valor do plano novo mas não
        // recebe os créditos correspondentes.
        if (nomeOfertaRecebido && !planoDoPayload) {
          await enviarAlertaAdmin({
            assunto: 'Webhook Cakto: nome de oferta não reconhecido',
            corpo:
              'O evento subscription_renewed chegou com offer.name = "' + nomeOfertaRecebido + '", ' +
              'que não bate com nenhuma entrada de NOME_OFERTA_PARA_PLANO (webhooks.js).\n\n' +
              'Cliente: ' + email + ' (evento ' + eventoId + ')\n' +
              'Plano atual no banco: ' + usuario.plano_atual + '\n\n' +
              'O backend creditou os créditos do plano ATUAL (sem trocar de plano) até que isso ' +
              'seja corrigido. Verifique se o nome da oferta no painel da Cakto mudou e ajuste o ' +
              'mapa em webhooks.js, ou faça o ajuste manual de crédito pelo backoffice se o ' +
              'cliente já pagou o upgrade.',
          });
        }

        const plano = planoValido(planoDoPayload) && planoDoPayload !== usuario.plano_atual
          ? planoDoPayload
          : usuario.plano_atual;
        if (!planoValido(plano)) break;

        await creditarOuFalhar(usuario.id, PLANOS[plano].creditos_mes, 'credito_mensal',
          'renovação — ' + eventoId);

        const patch = { status: 'ativo', trial_ativo: false, atualizado_em: new Date().toISOString() };
        if (plano !== usuario.plano_atual) {
          patch.plano_atual = plano;
          patch.data_upgrade = new Date().toISOString();
        }
        await supabase.from('usuarios').update(patch).eq('id', usuario.id);
        break;
      }

      case 'subscription_renewal_refused': {
        const usuario = await buscarUsuarioPorEmail(email);
        if (usuario) {
          await supabase
            .from('usuarios')
            .update({ status: 'pagamento_pendente', atualizado_em: new Date().toISOString() })
            .eq('id', usuario.id);
        }
        break;
      }

      case 'subscription_canceled': {
        const usuario = await buscarUsuarioPorEmail(email);
        if (usuario) {
          // créditos existentes NÃO são removidos — o usuário mantém
          // o que já pagou até o fim do ciclo corrente.
          await supabase
            .from('usuarios')
            .update({ status: 'cancelado', atualizado_em: new Date().toISOString() })
            .eq('id', usuario.id);
        }
        break;
      }

      case 'chargeback': {
        const usuario = await buscarUsuarioPorEmail(email);
        if (usuario) {
          await supabase
            .from('usuarios')
            .update({ status: 'suspenso', atualizado_em: new Date().toISOString() })
            .eq('id', usuario.id);
          console.warn('[webhook] CHARGEBACK — revisão manual necessária:', email);
          await enviarAlertaAdmin({
            assunto: 'Chargeback recebido — conta suspensa',
            corpo:
              'Cliente ' + email + ' contestou a cobrança no banco (evento ' + eventoId + ').\n' +
              'A conta já foi marcada como "suspenso" automaticamente.\n' +
              'Revise o caso no backoffice (/admin/usuarios) e decida se há necessidade de ação adicional.',
        });
        }
        break;
      }

      case 'refund': {
        console.warn('[webhook] REEMBOLSO recebido — revisar manualmente no backoffice:', email, eventoId);
        await enviarAlertaAdmin({
          assunto: 'Reembolso recebido — revisão manual necessária',
          corpo:
            'Cliente ' + email + ' recebeu reembolso (evento ' + eventoId + ').\n' +
            'O backend NãO debitou créditos automaticamente para este evento — decida manualmente ' +
            'pelo backoffice (/admin/usuarios/:id/ajuste-credito) se � preciso remover créditos ' +
            'ainda não utilizados deste ciclo.',
        });
        break;
      }

      default:
        // eventos como initiate_checkout, checkout_abandonment, pix_gerado etc.
        // não exigem ação de crédito — apenas logamos para referência.
        console.log('[webhook cakto] evento sem ação definida:', evento);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[webhook cakto] erro ao processar evento', evento, err.message);
    // Libera a marca de idempotência para que o reenvio da Cakto
    // possa reprocessar este evento do zero.
    await liberarEvento(eventoId).catch(() => {});
    return res.status(500).json({ erro: 'falha ao processar evento' });
  }
});

// O rpc do supabase-js não lança exceção — devolve { error }. Sem esta
// checagem, uma falha no crédito passava silenciosa e o evento era
// marcado como processado sem creditar ninguém.
async function creditarOuFalhar(usuarioId, quantidade, tipo, referencia) {
  const { error } = await supabase.rpc('creditar', {
    p_usuario_id: usuarioId,
    p_quantidade: quantidade,
    p_tipo: tipo,
    p_referencia: referencia,
  });
  if (error) throw new Error('falha ao creditar: ' + error.message);
}

module.exports = router;
