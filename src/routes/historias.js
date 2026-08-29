const express = require('express');
const router = express.Router();
const { supabase } = require('../db');
const { requireAuth } = require('../lib/authMiddleware');
const { CUSTO_HISTORIA, tamanhoValido } = require('../lib/planos');
const { gerarFase1, gerarIlustracao } = require('../lib/ia');

router.use(requireAuth);

// POST /historias/fase1
// Body: { nome, idade, tema, licao, tamanho, aparencia, perfil }
// Debita o crédito ANTES de chamar a IA; devolve automaticamente se falhar.
router.post('/fase1', async (req, res) => {
  const { nome, idade, tema, licao, tamanho, aparencia, perfil } = req.body || {};

  if (!nome || !tema || !licao) {
    return res.status(400).json({ erro: 'Preencha nome, tema e o que gostaria de conversar.' });
  }
  if (!tamanhoValido(tamanho)) {
    return res.status(400).json({ erro: 'Tamanho de história inválido.' });
  }

  const custo = CUSTO_HISTORIA[tamanho];

  // 1. debita o crédito de forma atômica — se o saldo for insuficiente,
  //    falha AQUI, antes de criar qualquer registro (evita histórias-lixo
  //    em falha_total no banco só porque faltou crédito).
  const { error: debitoErr } = await supabase.rpc('debitar', {
    p_usuario_id: req.userId,
    p_quantidade: custo,
    p_referencia: 'historia:pendente',
  });
  if (debitoErr) {
    const msg = debitoErr.message.includes('creditos_insuficientes')
      ? 'Créditos insuficientes para uma história ' + tamanho + ' (custa ' + custo + ').'
      : 'Não foi possível debitar os créditos.';
    return res.status(402).json({ erro: msg });
  }

  // 2. cria o registro da história em status "gerando"
  const { data: historia, error: insErr } = await supabase
    .from('historias')
    .insert({ usuario_id: req.userId, tamanho, creditos_custo: custo, status: 'gerando' })
    .select()
    .single();
  if (insErr) {
    // não conseguimos nem registrar a história — devolve o crédito e sai
    await supabase.rpc('creditar', {
      p_usuario_id: req.userId, p_quantidade: custo,
      p_tipo: 'estorno', p_referencia: 'falha ao registrar história',
    });
    return res.status(500).json({ erro: 'Não foi possível iniciar a geração.', creditos_devolvidos: custo });
  }

  // amarra o débito ao id real da história no extrato
  await supabase
    .from('creditos_extrato')
    .update({ referencia: 'historia:' + historia.id })
    .eq('usuario_id', req.userId)
    .eq('referencia', 'historia:pendente');

  // 3. chama a Anthropic (Fase 1)
  const input =
    'Nome da criança ou personagem principal: ' + nome +
    '\nIdade: ' + (idade || '?') + ' anos' +
    '\nTema favorito: ' + tema +
    '\nLição desejada: ' + licao +
    '\nTamanho: ' + tamanho +
    '\nCaracterísticas físicas do personagem: ' + (aparencia || 'não informado') +
    '\nHistórico médico: ' + (perfil || 'nenhum');

  try {
    const dados = await gerarFase1(input);

    await supabase
      .from('historias')
      .update({ titulo: dados.cabecalho?.titulo, status: 'completa', dados_json: dados })
      .eq('id', historia.id);

    return res.json({ ok: true, historia_id: historia.id, custo, dados });
  } catch (err) {
    // FALHA TOTAL — devolve o crédito integralmente
    await supabase.rpc('creditar', {
      p_usuario_id: req.userId,
      p_quantidade: custo,
      p_tipo: 'estorno',
      p_referencia: 'falha na geração — historia:' + historia.id,
    });
    await supabase.from('historias').update({ status: 'falha_total' }).eq('id', historia.id);

    return res.status(502).json({
      erro: classificarErroIA(err),
      creditos_devolvidos: custo,
    });
  }
});

// POST /historias/:id/ilustracao
// Body: { cena, aparencia, refImageUrl }
// Chamado uma vez por ilustração do plano — o frontend controla o
// paralelismo (pool) e o retry; aqui é só o proxy autenticado do Flux.
router.post('/:id/ilustracao', async (req, res) => {
  const { id } = req.params;
  const { cena, aparencia, refImageUrl } = req.body || {};

  // guardas de entrada — sem elas, dados_json nulo ou cena malformada
  // derrubavam o handler com 500 genérico
  if (!cena || typeof cena !== 'object' || !cena.descricao_visual) {
    return res.status(400).json({ erro: 'Cena inválida' });
  }
  if (refImageUrl && !/^https:\/\//.test(String(refImageUrl))) {
    return res.status(400).json({ erro: 'refImageUrl inválida' });
  }

  const { data: historia } = await supabase
    .from('historias')
    .select('usuario_id, status, dados_json')
    .eq('id', id)
    .maybeSingle();

  if (!historia || historia.usuario_id !== req.userId) {
    return res.status(404).json({ erro: 'História não encontrada' });
  }
  if (!historia.dados_json?.dna_visual) {
    return res.status(409).json({ erro: 'História ainda não tem plano visual (status: ' + historia.status + ')' });
  }

  try {
    const url = await gerarIlustracao({
      dna: historia.dados_json.dna_visual,
      cena,
      aparencia,
      refImageUrl,
    });
    res.json({ ok: true, url });
  } catch (err) {
    res.status(502).json({ erro: err.message });
  }
});

// GET /historias — lista as histórias do usuário logado
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('historias')
    .select('id, titulo, tamanho, creditos_custo, status, criado_em')
    .eq('usuario_id', req.userId)
    .order('criado_em', { ascending: false });
  if (error) return res.status(500).json({ erro: 'Não foi possível listar as histórias' });
  res.json({ historias: data });
});

// GET /historias/:id — detalhe completo (para reabrir e gerar o PDF de novo)
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('historias')
    .select('*')
    .eq('id', req.params.id)
    .eq('usuario_id', req.userId)
    .single();
  if (error) return res.status(404).json({ erro: 'História não encontrada' });
  res.json({ historia: data });
});

function classificarErroIA(err) {
  const msg = err.message || String(err);
  if (/timeout/i.test(msg)) return 'O serviço de IA demorou demais para responder. Tente novamente.';
  if (/authentication|api.key|401|403/i.test(msg)) return 'Erro de configuração do servidor (chave de API). Contate o suporte.';
  if (/insufficient|balance|credit|429|529|overloaded/i.test(msg)) return 'O serviço de IA está indisponível no momento. Tente novamente em alguns minutos.';
  return 'Não foi possível gerar a história agora. Tente novamente.';
}

module.exports = router;
