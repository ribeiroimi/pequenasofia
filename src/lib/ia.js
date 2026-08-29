const { PROMPT_FASE1, buildFluxPrompt } = require('./prompts');

// fetch com timeout — antes só a chamada ao fal.ai tinha abort; a da
// Anthropic podia pendurar a requisição HTTP do usuário indefinidamente.
async function fetchComTimeout(url, opts, timeoutMs, nomeServico) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? nomeServico + ': timeout ' + Math.round(timeoutMs / 1000) + 's'
      : nomeServico + ': erro de rede — ' + e.message);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Anthropic (Claude) — Fase 1: história + plano de ilustrações ----------
async function gerarFase1(inputTexto) {
  const res = await fetchComTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: [{ type: 'text', text: PROMPT_FASE1, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: inputTexto }],
    }),
  }, 120000, 'Anthropic');

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    throw new Error('Anthropic: ' + (data.error?.message || data.error?.type || ('HTTP ' + res.status)));
  }
  const raw = data.content?.[0]?.text;
  if (!raw) throw new Error('Anthropic: resposta vazia (stop_reason: ' + data.stop_reason + ')');

  const clean = raw.replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* cai no throw abaixo */ }
    }
    throw new Error('Anthropic: resposta em formato inesperado');
  }
}

// ---------- fal.ai (Flux 2 Pro) — Fase 2: uma ilustração por chamada ----------
const FLUX_DIMS = {
  capa: { width: 768, height: 1024 },
  pagina_inteira: { width: 768, height: 1024 },
  meia_pagina: { width: 768, height: 512 },
  vinheta: { width: 512, height: 512 },
};

async function gerarIlustracao({ dna, cena, aparencia, refImageUrl }) {
  const dims = FLUX_DIMS[cena.tipo] || FLUX_DIMS.pagina_inteira;
  const prompt = buildFluxPrompt(dna, cena, aparencia);

  const body = {
    prompt: refImageUrl ? '@reference ' + prompt : prompt,
    image_size: { width: dims.width, height: dims.height },
    num_inference_steps: 28,
    guidance_scale: 3.5,
    num_images: 1,
    enable_safety_checker: true,
    negative_prompt:
      'black background, dark background, colored background, checkerboard background, ' +
      'grid pattern background, pattern on clothing, texture on character body, dense details, ' +
      'cross-hatching, stippling, complex patterns, decorative prints, busy backgrounds, ' +
      'color, colored, colorful, dark fill, dark areas, filled black regions, painted, ' +
      'watercolor, pastel, tinted, shading, shadow fill, gradient, fabric pattern, polka dots on characters',
  };
  if (refImageUrl && cena.tipo !== 'capa') {
    body.reference_images = [{ url: refImageUrl, weight: 0.85 }];
  }

  const res = await fetchComTimeout('https://fal.run/fal-ai/flux-2-pro', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Key ' + process.env.FAL_API_KEY },
    body: JSON.stringify(body),
  }, 90000, 'fal.ai');

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || data.detail) {
    throw new Error('fal.ai: ' + (data.error?.message || data.detail || ('HTTP ' + res.status)));
  }
  if (!data.images?.[0]?.url) throw new Error('fal.ai: sem imagem na resposta');
  return data.images[0].url;
}

module.exports = { gerarFase1, gerarIlustracao };
