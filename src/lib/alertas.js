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


// Envia as credenciais de acesso (e-mail + senha) para o CLIENTE, uma unica
// vez, no momento em que a assinatura e criada pelo webhook. O login em si
// e feito direto pelo frontend via signInWithPassword do Supabase - este
// e-mail so precisa chegar uma vez, nao a cada acesso.
async function enviarCredenciaisCliente({ email, nome, senha }) {
  const apiKey = process.env.RESEND_API_KEY;
  const remetente = process.env.ALERT_FROM_EMAIL || 'contato@pequenasofia.com';

  if (!apiKey) {
    console.log('[credenciais cliente] (Resend nao configurado) e-mail=' + email + ' senha=' + senha);
    return false;
  }

  const corpo = 'Ola' + (nome ? ', ' + nome : '') + '!' + NL + NL +
    'Sua conta na Pequena Sofia esta pronta. Use os dados abaixo para entrar:' + NL + NL +
    'E-mail: ' + email + NL +
    'Senha: ' + senha + NL + NL +
    'Acesse: https://pequenasofia-production.up.railway.app/app.html' + NL + NL +
    'Guarde esta senha em local seguro.';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        from: remetente,
        to: email,
        subject: 'Seu acesso a Pequena Sofia',
        text: corpo,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error('[credenciais cliente] falha ao enviar via Resend: ' + (data.message || res.status));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[credenciais cliente] erro ao enviar via Resend:', err.message);
    return false;
  }
}
module.exports = { enviarAlertaAdmin, enviarCredenciaisCliente };
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
