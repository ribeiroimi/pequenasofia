const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY no .env -- veja .env.example'
  );
}

// service_role key: usada só no backend, nunca no frontend.
// Ela ignora as regras de RLS, então o próprio backend é responsável
// por só devolver/alterar dados do usuário correto em cada rota.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

module.exports = { supabase };
