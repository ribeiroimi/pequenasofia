// Envio de alertas por e-mail para o admin — usado quando o backend
// encontra uma situação que precisa de revisão manual: evento de
// webhook com plano ambíguo, chargeback, reembolso, etc.
//
// Usa a API REST do Resend diretamente via fetch (sem SDK extra, para não
// crescer o package.json por causa de um único envio). Se as variáveis de
// ambiente não estiverem configuradas, ou se o envio falhar por qualquer
// motivo, a função apenas loga o erro — NUNCA deve derrubar o fluxo que a
// chamou (o pior cenário aceitável é "não avisou", nunca "webhook quebrou
// porque o e-mail falhou").

async function enviarAlertaAdmin({ assunto, corpo }) {
  const apiKey = process.env.RESEND_API_KEY;
  const destino = process.env.ADMIN_ALERT_EMAIL;
  const remetente = process.env.ALERT_FROM_EMAIL || 'alertas@pequenasofia.com';

  if (!apiKey || !destino) {
    console.warn('[alerta] RESEND_API_KEY/ADMIN_ALERT_EMAIL não configurados — alerta ficou só no log:');
    console.warn('[alerta]', assunto, '—', corpo);
    return;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        from: remetente,
        to: destino,
        subject: '[Pequena Sofia] ' + assunto,
        text: corpo,
      }),
    });
    if (!res.ok) {
      const detalhe = await res.text().catch(() => '');
      console.error('[alerta] Resend recusou o envio:', res.status, detalhe);
    }
  } catch (err) {
    console.error('[alerta] falha de rede ao enviar e-mail de alerta:', err.message);
  }
}

module.exports = { enviarAlertaAdmin };
