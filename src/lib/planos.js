// Definição central dos planos e dos custos por tamanho de história.
// Se um dia os preços ou créditos mudarem, é só editar aqui.

const PLANOS = {
  // preco = valor no cartão; no Pix Automático o HeroSpark aplica 10% de desconto.
  curioso:  { label: 'Curioso',  creditos_mes: 3, preco: 14.00 },
  pensador: { label: 'Pensador', creditos_mes: 6, preco: 24.90 },
  filosofo: { label: 'Filósofo', creditos_mes: 9, preco: 33.90 },
};

const CUSTO_HISTORIA = {
  curta: 1,
  media: 2,
  longa: 3,
};

function planoValido(nome) {
  return Object.prototype.hasOwnProperty.call(PLANOS, nome);
}

function tamanhoValido(nome) {
  return Object.prototype.hasOwnProperty.call(CUSTO_HISTORIA, nome);
}

module.exports = { PLANOS, CUSTO_HISTORIA, planoValido, tamanhoValido };
