// Deve ser o primeiro require: instrumenta o Router do Express para
// capturar rejeições de Promise em handlers async automaticamente —
// sem isso, uma falha assíncrona não tratada (ex: erro do Supabase) derruba
// o processo inteiro em vez de virar uma resposta HTTP de erro.
require('express-async-errors');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

const authRoutes = require('./src/routes/auth');
const meRoutes = require('./src/routes/me');
const historiasRoutes = require('./src/routes/historias');
const webhooksRoutes = require('./src/routes/webhooks');
const adminRoutes = require('./src/routes/admin');

const app = express();

// Atrás de um proxy (Railway/Vercel/etc.), req.ip só reflete o IP real
// do cliente com trust proxy ligado — necessário para o rate limit do login.
// Configurável via TRUST_PROXY_HOPS: hoje o Railway coloca 1 proxy na frente,
// mas se um CDN (ex: Cloudflare) for adicionado depois, isso pode virar 2.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS, 10) || 1);
app.disable('x-powered-by');

// Comprime respostas acima de 1KB (gzip) — reduz tráfego, especialmente em
// respostas grandes como o texto completo de uma história gerada.
app.use(compression({ threshold: 1024 }));

// ------------------------------------------------------------------
// Shutdown gracioso: durante um redeploy, o Railway envia SIGTERM antes
// de matar o processo. Sem isso, requisições em andamento são cortadas
// no meio. Aqui: paramos de aceitar requisições novas (503), deixamos as
// em andamento terminarem, e só então encerramos o processo.
// ------------------------------------------------------------------
let shuttingDown = false;
app.use((req, res, next) => {
  if (shuttingDown) {
    res.set('Connection', 'close');
    return res.status(503).json({ erro: 'Servidor reiniciando, tente novamente em instantes.' });
  }
  next();
});

// CORS — só os domínios listados em ALLOWED_ORIGINS podem chamar esta API.
// Requisições sem Origin (webhooks da Cakto, curl, server-to-server) passam.
const origensPermitidas = new Set(
  (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
);
app.use(cors({
  origin(origin, callback) {
    if (!origin || origensPermitidas.has(origin)) return callback(null, true);
    const err = new Error('Origem não permitida pelo CORS');
    err.status = 403;
    callback(err);
  },
}));

app.use(express.json({ limit: '2mb' }));

// /health continua respondendo JSON para monitoramento (UptimeRobot, Railway healthcheck, etc.)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// app.html é o frontend (área logada) - servido diretamente por este mesmo
// backend, para não precisar de um segundo host/domínio só para o frontend.
// Cache-Control: no-cache permite que o navegador guarde uma cópia mas
// sempre revalide com o servidor antes de usá-la — evita servir uma versão
// desatualizada do app depois de um deploy, sem forçar re-download completo
// a cada visita.
app.get('/app.html', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'app.html'));
});
app.get('/', (req, res) => res.redirect('/app.html'));

app.use('/auth', authRoutes);
app.use('/me', meRoutes);
app.use('/historias', historiasRoutes);
app.use('/webhooks', webhooksRoutes);
app.use('/admin', adminRoutes);

// 404 em JSON para rotas desconhecidas (antes caía no HTML padrão do Express)
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada' }));

// handler de erro genérico — evita que o processo caia por exceção não tratada.
// Mensagens diferenciadas por faixa de status: um JSON malformado ou corpo
// grande demais (400/413, gerados pelo próprio express.json()) é erro do
// CLIENTE, não do servidor — dizer "erro interno" nesses casos é enganoso.
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[erro não tratado]', err);

  let erro;
  if (status === 403) erro = 'Origem não permitida';
  else if (status === 400) erro = err.type === 'entity.parse.failed' ? 'JSON inválido no corpo da requisição' : 'Requisição inválida';
  else if (status === 413) erro = 'Corpo da requisição excede o limite permitido (2MB)';
  else if (status >= 500) erro = 'Erro interno do servidor';
  else erro = err.message || 'Erro na requisição';

  res.status(status).json({ erro });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log('Pequena Sofia backend rodando na porta ' + PORT);
});

function encerrarComGraca(sinal) {
  console.log('[shutdown] ' + sinal + ' recebido, encerrando graciosamente...');
  shuttingDown = true;
  server.close(() => {
    console.log('[shutdown] todas as conexões encerradas, saindo.');
    process.exit(0);
  });
  // rede de segurança: se alguma conexão nunca fechar, força a saída
  setTimeout(() => {
    console.warn('[shutdown] tempo esgotado, forçando saída.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => encerrarComGraca('SIGTERM'));
process.on('SIGINT', () => encerrarComGraca('SIGINT'));
