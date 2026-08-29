// Definição central dos planos e dos custos por tamanho de história.
// Se um dia os preços ou créditos mudarem, é só editar aqui.

const PLANOS = {
  curioso:  { label: 'Curioso',  creditos_mes: 3, preco: 12.00 },
  pensador: { label: 'Pensador', creditos_mes: 6, preco: 21.00 },
  filosofo: { label: 'Filósofo', creditos_mes: 9, preco: 29.00 },
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
