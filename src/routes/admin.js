const express = require('express');
const router = express.Router();
const { supabase } = require('../db');
const { requireAdmin } = require('../lib/authMiddleware');

router.use(requireAdmin);

// GET /admin/usuarios?status=ativo&plano=pensador&pagina=1
router.get('/usuarios', async (req, res) => {
  const pagina = Math.max(parseInt(req.query.pagina, 10) || 1, 1);
  const porPagina = 100;
  let query = supabase
    .from('usuarios')
    .select('*, creditos_saldo(saldo_atual)', { count: 'exact' })
    .order('criado_em', { ascending: false })
    .range((pagina - 1) * porPagina, pagina * porPagina - 1);
  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.plano) query = query.eq('plano_atual', req.query.plano);

  const { data, count, error } = await query;
  if (error) return res.status(500).json({ erro: 'Erro ao listar usuários' });
  res.json({ usuarios: data, total: count, pagina, por_pagina: porPagina });
});

// GET /admin/usuarios/:id — detalhe completo
router.get('/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  const [{ data: usuario }, { data: extrato }, { data: historias }] = await Promise.all([
    supabase.from('usuarios').select('*, creditos_saldo(saldo_atual)').eq('id', id).single(),
    supabase.from('creditos_extrato').select('*').eq('usuario_id', id).order('criado_em', { ascending: false }).limit(50),
    supabase.from('historias').select('id, titulo, tamanho, status, criado_em').eq('usuario_id', id).order('criado_em', { ascending: false }),
  ]);
  if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
  res.json({ usuario, extrato, historias });
});

// POST /admin/usuarios/:id/ajuste-credito  { quantidade, motivo }
router.post('/usuarios/:id/ajuste-credito', async (req, res) => {
  const { id } = req.params;
  const { quantidade, motivo } = req.body || {};

  // quantidade precisa ser inteiro não-nulo — sem isso o RPC aceitava
  // "1.5", strings numéricas etc. e o extrato ficava inconsistente
  if (!Number.isInteger(quantidade) || quantidade === 0) {
    return res.status(400).json({ erro: 'quantidade deve ser um inteiro diferente de zero' });
  }
  if (!motivo || typeof motivo !== 'string' || !motivo.trim()) {
    return res.status(400).json({ erro: 'Informe o motivo do ajuste' });
  }

  const fn = quantidade > 0 ? 'creditar' : 'debitar';
  const params = quantidade > 0
    ? { p_usuario_id: id, p_quantidade: quantidade, p_tipo: 'ajuste_manual', p_referencia: motivo.trim() }
    : { p_usuario_id: id, p_quantidade: Math.abs(quantidade), p_referencia: '[ajuste manual] ' + motivo.trim() };

  const { error } = await supabase.rpc(fn, params);
  if (error) {
    const msg = error.message.includes('creditos_insuficientes')
      ? 'O usuário não tem saldo suficiente para este débito.'
      : 'Não foi possível ajustar o crédito: ' + error.message;
    return res.status(400).json({ erro: msg });
  }
  res.json({ ok: true });
});

// GET /admin/metricas — agregação feita no banco (função metricas_admin
// do schema.sql), em vez de baixar todos os usuários para contar em JS.
router.get('/metricas', async (req, res) => {
  const { data, error } = await supabase.rpc('metricas_admin');
  if (error) return res.status(500).json({ erro: 'Erro ao calcular métricas: ' + error.message });
  res.json(data);
});

module.exports = router;
