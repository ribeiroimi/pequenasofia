const crypto = require('crypto');
const { supabase } = require('../db');

// Espera o header: Authorization: Bearer <token do Supabase Auth>
// O token é o mesmo que o frontend recebe depois do login por magic link.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: 'Token de autenticação ausente' });

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ erro: 'Sessão inválida ou expirada' });

  req.userId = data.user.id;
  req.userEmail = data.user.email;
  next();
}

// Protege as rotas /admin/* com uma senha simples via header.
// MVP apenas — numa v2 trocar por login de admin de verdade.
// Comparação em tempo constante para não vazar o secret por timing.
function requireAdmin(req, res, next) {
  const chave = String(req.headers['x-admin-secret'] || '');
  const esperado = String(process.env.ADMIN_SECRET || '');
  const a = Buffer.from(chave);
  const b = Buffer.from(esperado);
  const ok = esperado.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ erro: 'Acesso de administrador negado' });
  next();
}

module.exports = { requireAuth, requireAdmin };
