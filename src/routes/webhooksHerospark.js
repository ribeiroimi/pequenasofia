const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { supabase } = require('../db');
const { PLANOS, planoValido } = require('../lib/planos');
const { enviarAlertaAdmin, enviarCredenciaisCliente } = require('../lib/alertas');

// ------------------------------------------------------------------
// Webhook do HeroSpark (substitui o da Cakto).
//
// Cada automação do HeroSpark faz um POST para esta rota com:
//   - header  X-Webhook-Secret: <HEROSPARK_WEBHOOK_SECRET>
//   - corpo JSON com o campo "event" (ver EVENTOS abaixo)
//
// O HeroSpark NÃO manda um id único de evento, então a idempotência usa
// o payment_id (único por cobrança) nos eventos que mexem em crédito.
// ------------------------------------------------------------------

// offer_id do HeroSpark → plano interno. Cada plano tem duas ofertas
// (Cartão e Pix Automático). Se criar uma oferta nova, acrescente aqui.
const OFERTA_PARA_PLANO = {
  '546167': 'curioso',   // Curioso - Cartão
  '546168': 'curioso',   // Curioso - Pix Automático
  '546170': 'pensador',  // Pensador - Cartão
  '546171': 'pensador',  // Pensador - Pix Automático
  '546464': 'filosofo',  // Filósofo - Cartão
  '546465': 'filosofo',  // Filósofo - Pix Automático
};

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Primeiro pelo offer_id (confiável). Se a oferta não estiver no mapa, tenta
// pelo título ("Curioso - Cartão" etc.). Retorna null se não reconhecer —
// nunca assume um plano, para não creditar o plano errado.
function identificarPlano(p) {
  const porId = OFERTA_PARA_PLANO[String(p.offer_id || '')];
  if (porId) return porId;
  const titulo = semAcento(p.offer_title) + ' ' + semAcento(p.product_name);
  const achados = ['curioso', 'pensador', 'filosofo'].filter((n) => titulo.includes(n));
  return achados.length === 1 ? achados[0] : null;
}

function normalizarEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Comparação em tempo constante. Se o secret não estiver configurado no
// servidor, REJEITA tudo (nunca aceita "vazio == vazio").
function secretConfere(recebido) {
  const esperado = process.env.HEROSPARK_WEBHOOK_SECRET || '';
  if (!esperado) return false;
  const a = Buffer.from(String(recebido || ''));
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function gerarSenhaAleatoria() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let senha = '';
  for (let i = 0; i < 14; i++) senha += alfabeto[crypto.randomInt(alfabeto.length)];
  return senha;
}

async function reivindicarEvento(eventoId, eventoTipo) {
  const { error } = await supabase
    .from('webhook_eventos_processados')
    .insert({ evento_id: eventoId, evento_tipo: eventoTipo });
  if (!error) return true;
  if (error.code === '23505') return false;
  throw error;
}

async function liberarEvento(eventoId) {
  await supabase.from('webhook_eventos_processados').delete().eq('evento_id', eventoId);
}

async function buscarUsuarioPorEmail(email) {
  const { data } = await supabase.from('usuarios').select('*').eq('email', email).maybeSingle();
  return data;
}

async function creditarOuFalhar(usuarioId, quantidade, tipo, referencia) {
  const { error } = await supabase.rpc('creditar', {
    p_usuario_id: usuarioId,
    p_quantidade: quantidade,
    p_tipo: tipo,
    p_referencia: referencia,
  });
  if (error) throw new Error('falha ao creditar: ' + error.message);
}

// Eventos que mexem em crédito/alertas e por isso exigem idempotência.
const EVENTOS_COM_PAGAMENTO = new Set(['payment_confirmed', 'refunded_by_producer']);

async function pagamentoConfirmado(p, email) {
  const plano = identificarPlano(p);
  if (!email) throw new Error('payment_confirmed sem buyer_email');

  if (!plano) {
    await enviarAlertaAdmin({
      assunto: 'Webhook HeroSpark: oferta não reconhecida',
      corpo:
        'payment_confirmed chegou com offer_id = "' + p.offer_id + '" e offer_title = "' + p.offer_title + '", ' +
        'que não bate com nenhuma oferta conhecida (OFERTA_PARA_PLANO em webhooksHerospark.js).\n\n' +
        'Cliente: ' + email + ' (pagamento ' + p.payment_id + ')\n\n' +
        'Nenhum crédito foi dado e nenhuma conta foi criada. Acrescente a oferta ao mapa e peça ' +
        'o reenvio do evento no HeroSpark, ou ajuste manualmente pelo backoffice.',
    });
    return { ignorado: 'oferta_desconhecida' };
  }

  const nome = p.buyer_name || 'Cliente';
  let usuario = await buscarUsuarioPorEmail(email);

  if (!usuario) {
    // Primeira compra: cria o login (senha aleatória enviada por e-mail) e a
    // conta já no plano comprado. Não há mais mês grátis.
    const senha = gerarSenhaAleatoria();
    const { data: authUser, error: authErr } = await supabase.auth.admin.createUser({
      email,
      password: senha,
      email_confirm: true,
    });
    if (authErr) throw authErr;

    const { data: novo, error: insErr } = await supabase
      .from('usuarios')
      .insert({
        id: authUser.user.id,
        nome,
        email,
        plano_atual: plano,
        status: 'ativo',
        trial_ativo: false,
      })
      .select()
      .single();
    if (insErr) {
      // evita deixar um login órfão que travaria o reenvio do evento
      await supabase.auth.admin.deleteUser(authUser.user.id).catch(() => {});
      throw insErr;
    }
    usuario = novo;
    await guardarAssinatura(usuario.id, p.subscription_id);

    await creditarOuFalhar(usuario.id, PLANOS[plano].creditos_mes, 'credito_mensal',
      'assinatura criada — ' + p.payment_id);
    await enviarCredenciaisCliente({ email, nome, senha })
      .catch((e) => console.error('[credenciais cliente] erro:', e.message));
    return { conta: 'criada', plano };
  }

  // Cliente existente: renovação mensal ou troca de plano. Os créditos são
  // somados ao saldo atual, nunca substituídos.
  await alertarSeAssinaturaDuplicada(usuario, plano, p, email);

  await creditarOuFalhar(usuario.id, PLANOS[plano].creditos_mes, 'credito_mensal',
    (plano !== usuario.plano_atual ? 'troca de plano — ' : 'renovação — ') + p.payment_id);

  const patch = { status: 'ativo', trial_ativo: false, atualizado_em: new Date().toISOString() };
  if (plano !== usuario.plano_atual) {
    patch.plano_atual = plano;
    patch.data_upgrade = new Date().toISOString();
  }
  const { error } = await supabase.from('usuarios').update(patch).eq('id', usuario.id);
  if (error) throw error;
  await guardarAssinatura(usuario.id, p.subscription_id);
  return { conta: 'atualizada', plano };
}

// Guarda o id da assinatura vigente do cliente. É "melhor esforço": se a
// coluna ainda não existir no banco (SQL de migração não rodado), só registra
// no log e NÃO derruba a compra.
async function guardarAssinatura(usuarioId, subscriptionId) {
  if (!subscriptionId) return;
  const { error } = await supabase
    .from('usuarios')
    .update({ herospark_subscription_id: String(subscriptionId) })
    .eq('id', usuarioId);
  if (error) console.error('[webhook herospark] não foi possível guardar subscription_id:', error.message);
}

// Upgrade pelo app = compra nova no HeroSpark = assinatura NOVA, e a antiga
// continua cobrando até alguém cancelar. Quando chega um pagamento de uma
// assinatura diferente da guardada, avisa o admin qual cancelar.
// Não alerta se a conta estava cancelada (recompra legítima).
async function alertarSeAssinaturaDuplicada(usuario, planoNovo, p, email) {
  const nova = p.subscription_id ? String(p.subscription_id) : null;
  const antiga = usuario.herospark_subscription_id || null;
  if (!nova || usuario.status === 'cancelado') return;

  const idDiferente = antiga && antiga !== nova;
  const trocouSemHistorico = !antiga && planoNovo !== usuario.plano_atual;
  if (!idDiferente && !trocouSemHistorico) return;

  await enviarAlertaAdmin({
    assunto: 'Assinatura duplicada — cancele a antiga no HeroSpark',
    corpo:
      'O cliente ' + email + ' pagou uma assinatura nova e pode ter outra ainda ativa.\n\n' +
      'Plano anterior: ' + usuario.plano_atual + '\n' +
      'Plano novo: ' + planoNovo + ' (oferta ' + p.offer_id + ' — ' + p.offer_title + ')\n' +
      'Assinatura NOVA (manter): ' + nova + '\n' +
      'Assinatura ANTIGA (cancelar): ' + (antiga || 'desconhecida — procure pelo e-mail em Vendas/Membros') + '\n\n' +
      'Onde cancelar: HeroSpark → Vendas → procure o e-mail do cliente → cancelar a assinatura antiga.\n' +
      'Os créditos do plano novo já foram somados ao saldo. Quando a antiga for cancelada, o evento ' +
      'de cancelamento dela será ignorado automaticamente e a conta continua ativa.',
  });
}

// Eventos de atraso/cancelamento de uma assinatura DIFERENTE da vigente
// (ex.: a antiga, depois do upgrade) não devem mexer na conta.
async function assinaturaEhVigente(email, subscriptionId) {
  if (!subscriptionId) return true;
  const u = await buscarUsuarioPorEmail(email);
  if (!u || !u.herospark_subscription_id) return true;
  return u.herospark_subscription_id === String(subscriptionId);
}

// POST /api/webhooks/herospark  (e /webhooks/herospark)
router.post('/', async (req, res) => {
  if (!secretConfere(req.get('x-webhook-secret'))) {
    console.warn('[webhook herospark] secret inválido ou ausente');
    return res.status(401).json({ erro: 'secret inválido' });
  }

  const p = req.body || {};
  const evento = p.event;
  if (!evento) return res.status(400).json({ erro: 'payload sem event' });

  const email = normalizarEmail(p.buyer_email);

  // Idempotência só onde há efeito que não pode repetir (crédito/alerta).
  let chave = null;
  if (EVENTOS_COM_PAGAMENTO.has(evento)) {
    if (!p.payment_id) return res.status(400).json({ erro: 'payload sem payment_id' });
    chave = 'hs:' + evento + ':' + p.payment_id;
    try {
      if (!(await reivindicarEvento(chave, evento))) {
        return res.status(200).json({ ok: true, duplicado: true });
      }
    } catch (err) {
      console.error('[webhook herospark] erro ao registrar evento', err.message);
      return res.status(500).json({ erro: 'falha ao registrar evento' });
    }
  }

  try {
    let resultado = {};
    switch (evento) {
      case 'payment_confirmed': {
        resultado = await pagamentoConfirmado(p, email);
        if (resultado.ignorado && chave) await liberarEvento(chave);
        break;
      }

      case 'payment_overdue':
      case 'subscription_overdue': {
        // só marca pendência de quem está ativo; não mexe em suspenso/cancelado.
        // Créditos existentes ficam intactos.
        if (!(await assinaturaEhVigente(email, p.subscription_id))) {
          console.log('[webhook herospark] atraso de assinatura antiga ignorado:', email, p.subscription_id);
          resultado = { ignorado: 'assinatura_nao_vigente' };
          break;
        }
        await supabase
          .from('usuarios')
          .update({ status: 'pagamento_pendente', atualizado_em: new Date().toISOString() })
          .eq('email', email)
          .eq('status', 'ativo');
        break;
      }

      case 'subscription_canceled_by_customer':
      case 'subscription_canceled_by_system_or_producer': {
        // créditos existentes NÃO são removidos. Conta suspensa continua suspensa.
        // Cancelamento da assinatura ANTIGA (depois de um upgrade) não derruba a conta.
        if (!(await assinaturaEhVigente(email, p.subscription_id))) {
          console.log('[webhook herospark] cancelamento de assinatura antiga ignorado:', email, p.subscription_id);
          resultado = { ignorado: 'assinatura_nao_vigente' };
          break;
        }
        await supabase
          .from('usuarios')
          .update({ status: 'cancelado', atualizado_em: new Date().toISOString() })
          .eq('email', email)
          .neq('status', 'suspenso');
        break;
      }

      case 'refunded_by_producer': {
        console.warn('[webhook herospark] REEMBOLSO — revisar manualmente:', email, p.payment_id);
        await enviarAlertaAdmin({
          assunto: 'Reembolso recebido — revisão manual necessária',
          corpo:
            'Cliente ' + email + ' teve o pagamento ' + p.payment_id + ' reembolsado no HeroSpark.\n' +
            'O backend NÃO debitou créditos nem mudou o status da conta. Decida pelo backoffice ' +
            '(/admin/usuarios/:id/ajuste-credito) se é preciso remover créditos deste ciclo.',
        });
        break;
      }

      default:
        console.log('[webhook herospark] evento sem ação definida:', evento);
    }

    return res.status(200).json({ ok: true, ...resultado });
  } catch (err) {
    console.error('[webhook herospark] erro ao processar evento', evento, err.message);
    if (chave) await liberarEvento(chave).catch(() => {});
    return res.status(500).json({ erro: 'falha ao processar evento' });
  }
});

module.exports = router;
module.exports._interno = { identificarPlano, secretConfere, OFERTA_PARA_PLANO };
