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
