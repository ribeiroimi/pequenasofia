const express = require('express');
const router = express.Router();
const { supabase } = require('../db');

// ------------------------------------------------------------------
// Rate limit simples em memória para o magic link: máx. 3 envios por
// e-mail e 10 por IP a cada 15 minutos. Suficiente para o MVP em um
// único processo; se escalar para várias instâncias, trocar por
// express-rate-limit com store compartilhado (Redis).
// ------------------------------------------------------------------
const JANELA_MS = 15 * 60 * 1000;
const tentativas = new Map(); // chave → [timestamps]

function excedeuLimite(chave, max) {
  const agora = Date.now();
  const lista = (tentativas.get(chave) || []).filter(t => agora - t < JANELA_MS);
  if (lista.length >= max) { tentativas.set(chave, lista); return true; }
  lista.push(agora);
  tentativas.set(chave, lista);
  return false;
}
// limpeza periódica para o Map não crescer sem limite
setInterval(() => {
  const agora = Date.now();
  for (const [k, lista] of tentativas) {
    const viva = lista.filter(t => agora - t < JANELA_MS);
    if (viva.length) tentativas.set(k, viva); else tentativas.delete(k);
  }
}, JANELA_MS).unref();

// MESMA mensagem para e-mail existente e inexistente — se as mensagens
// diferem, qualquer um descobre quem é cliente testando e-mails.
const MSG_NEUTRA = 'Se este e-mail tiver uma assinatura ativa, você receberá o link de acesso em instantes.';

// POST /auth/login  { email }
// Envia um magic link por e-mail. O usuário clica, volta autenticado
// para o seu app (frontend), que troca o token da URL por uma sessão.
router.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ erro: 'Informe um e-mail válido' });

  const ip = req.ip || req.socket.remoteAddress || '?';
  if (excedeuLimite('email:' + email, 3) || excedeuLimite('ip:' + ip, 10)) {
    return res.status(429).json({ erro: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
  }

  const { data: usuario } = await supabase.from('usuarios').select('id').eq('email', email).maybeSingle();
  if (!usuario) {
    // Não envia nada, mas responde exatamente como no caso de sucesso.
    return res.status(200).json({ ok: true, mensagem: MSG_NEUTRA });
  }

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: process.env.ALLOWED_ORIGINS?.split(',')[0] },
  });
  if (error) {
    // Loga o detalhe no servidor, mas não vaza para o cliente.
    console.error('[auth] falha ao enviar magic link:', error.message);
    return res.status(500).json({ erro: 'Não foi possível enviar o link agora. Tente novamente.' });
  }

  return res.status(200).json({ ok: true, mensagem: MSG_NEUTRA });
});

module.exports = router;
