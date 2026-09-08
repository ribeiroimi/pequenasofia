require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./src/routes/auth');
const meRoutes = require('./src/routes/me');
const historiasRoutes = require('./src/routes/historias');
const webhooksRoutes = require('./src/routes/webhooks');
const adminRoutes = require('./src/routes/admin');

const app = express();

// Atrás de um proxy (Railway/Vercel/etc.), req.ip só reflete o IP real
// do cliente com trust proxy ligado — necessário para o rate limit do login.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// CORS — só os domínios listados em ALLOWED_ORIGINS podem chamar esta API.
// Requisições sem Origin (webhooks da Cakto, curl, server-to-server) passam.
const origensPermitidas = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || origensPermitidas.includes(origin)) return callback(null, true);
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
app.get('/app.html', (req, res) => res.sendFile(path.join(__dirname, 'app.html')));
app.get('/', (req, res) => res.redirect('/app.html'));

app.use('/auth', authRoutes);
app.use('/me', meRoutes);
app.use('/historias', historiasRoutes);
app.use('/webhooks', webhooksRoutes);
app.use('/admin', adminRoutes);

// 404 em JSON para rotas desconhecidas (antes caía no HTML padrão do Express)
app.use((req, res) => res.status(404).json({ erro: 'Rota não encontrada' }));

// handler de erro genérico — evita que o processo caia por exceção não tratada
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[erro não tratado]', err);
  res.status(status).json({ erro: status === 403 ? 'Origem não permitida' : 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Pequena Sofia backend rodando na porta ' + PORT);
});
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./src/routes/auth');
const meRoutes = require('./src/routes/me');
const historiasRoutes = require('./src/routes/historias');
const webhooksRoutes = require('./src/routes/webhooks');
const adminRoutes = require('./src/routes/admin');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

const origensPermitidas = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, callback) {
    if (!origin || origensPermitidas.includes(origin)) return callback(null, true);
    const err = new Error('Origem nao permitida pelo CORS');
    err.status = 403;
    callback(err);
  },
}));

app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => res.json({ status: 'ok', servico: 'Pequena Sofia backend' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRoutes);
app.use('/me', meRoutes);
app.use('/historias', historiasRoutes);
app.use('/webhooks', webhooksRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => res.status(404).json({ erro: 'Rota nao encontrada' }));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[erro nao tratado]', err);
  res.status(status).json({ erro: status === 403 ? 'Origem nao permitida' : 'Erro interno do servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Pequena Sofia backend rodando na porta ' + PORT);
});
