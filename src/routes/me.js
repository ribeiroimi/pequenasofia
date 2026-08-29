const express = require('express');
const router = express.Router();
const { supabase } = require('../db');
const { requireAuth } = require('../lib/authMiddleware');
const { PLANOS, planoValido } = require('../lib/planos');

router.use(requireAuth);

// GET /me — dados da conta + saldo
router.get('/', async (req, res) => {
  const { data: usuario, error } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', req.userId)
    .single();
  if (error) return res.status(404).json({ erro: 'Usuário não encontrado' });

  const { data: saldo } = await supabase
    .from('creditos_saldo')
    .select('saldo_atual')
    .eq('usuario_id', req.userId)
    .maybeSingle();

  res.json({
    nome: usuario.nome,
    email: usuario.email,
    telefone: usuario.telefone,
    plano_atual: usuario.plano_atual,
    plano_label: PLANOS[usuario.plano_atual]?.label,
    status: usuario.status,
    trial_ativo: usuario.trial_ativo,
    trial_fim: usuario.trial_fim,
    saldo_creditos: saldo?.saldo_atual ?? 0,
  });
});

// PUT /me — atualizar nome/telefone (nunca CPF, nunca e-mail de login aqui)
router.put('/', async (req, res) => {
  const nome = typeof req.body?.nome === 'string' ? req.body.nome.trim().slice(0, 120) : '';
  const telefone = typeof req.body?.telefone === 'string' ? req.body.telefone.trim().slice(0, 30) : '';
  const patch = { atualizado_em: new Date().toISOString() };
  if (nome) patch.nome = nome;
  if (telefone) patch.telefone = telefone;

  const { error } = await supabase.from('usuarios').update(patch).eq('id', req.userId);
  if (error) return res.status(500).json({ erro: 'Não foi possível atualizar' });
  res.json({ ok: true });
});

// POST /me/upgrade  { plano: 'pensador' | 'filosofo' }
// IMPORTANTE: este endpoint só atualiza o registro local depois que o
// pagamento do novo plano for confirmado via webhook da Cakto. Aqui ele
// apenas devolve para o frontend a URL de checkout para onde redirecionar
// o usuário — a troca de fato acontece quando o webhook subscription_renewed
// (ou equivalente) chegar.
// Os links vêm do .env (CHECKOUT_URL_PENSADOR / CHECKOUT_URL_FILOSOFO) —
// nada de URL de ambiente hardcoded no código.
function linksCheckout() {
  return {
    pensador: process.env.CHECKOUT_URL_PENSADOR,
    filosofo: process.env.CHECKOUT_URL_FILOSOFO,
  };
}

router.post('/upgrade', async (req, res) => {
  const { plano } = req.body || {};
  if (!planoValido(plano) || plano === 'curioso') {
    return res.status(400).json({ erro: 'Plano de upgrade inválido' });
  }
  const link = linksCheckout()[plano];
  if (!link) {
    console.error('[upgrade] CHECKOUT_URL_' + plano.toUpperCase() + ' não configurada no .env');
    return res.status(500).json({ erro: 'Upgrade temporariamente indisponível. Tente mais tarde.' });
  }
  res.json({
    ok: true,
    redirecionar_para: link,
    aviso: 'Seus créditos atuais serão preservados e somados aos do novo plano assim que o pagamento for confirmado.',
  });
});

// POST /me/cancelar — marca intenção; o cancelamento efetivo do lado da
// Cakto deve ser feito pelo usuário no e-mail de gestão de assinatura que
// a Cakto envia, OU via chamada à API da Cakto se/quando disponibilizada
// para cancelamento programático. Aqui registramos a intenção no backoffice.
router.post('/cancelar', async (req, res) => {
  const { error } = await supabase
    .from('usuarios')
    .update({ status: 'cancelamento_solicitado', atualizado_em: new Date().toISOString() })
    .eq('id', req.userId);
  if (error) return res.status(500).json({ erro: 'Não foi possível registrar o cancelamento' });
  res.json({
    ok: true,
    mensagem: 'Cancelamento registrado. Você continua com acesso até o fim do ciclo já pago.',
  });
});

// GET /me/extrato?meses=3
router.get('/extrato', async (req, res) => {
  const meses = Math.min(Math.max(parseInt(req.query.meses, 10) || 3, 1), 12);
  const desde = new Date();
  desde.setMonth(desde.getMonth() - meses);

  const { data, error } = await supabase
    .from('creditos_extrato')
    .select('tipo, quantidade, saldo_apos, referencia, criado_em')
    .eq('usuario_id', req.userId)
    .gte('criado_em', desde.toISOString())
    .order('criado_em', { ascending: false })
    .limit(500);

  if (error) return res.status(500).json({ erro: 'Não foi possível carregar o extrato' });
  res.json({ extrato: data });
});

module.exports = router;
