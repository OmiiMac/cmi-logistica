const express = require('express');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/send-ruta', async (req, res) => {
  const { to, conductor, fecha, hora, origen, destino, descripcion } = req.body;
  if (!to || !descripcion) return res.status(400).json({ error: 'Faltan datos' });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Sin API key configurada' });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#9B1B30;padding:24px 28px;border-radius:12px 12px 0 0">
        <div style="color:#fff;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.7">CMI Construction Corp</div>
        <div style="color:#fff;font-size:22px;font-weight:700;margin-top:4px">Ruta Asignada</div>
      </div>
      <div style="background:#fff;border:1px solid #E2E1DE;border-top:none;padding:28px;border-radius:0 0 12px 12px">
        <div style="font-size:15px;color:#1B1B20;margin-bottom:20px">Hola <strong>${conductor}</strong>, tienes una ruta asignada:</div>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:10px 14px;background:#F0EEE9;border-radius:8px 8px 0 0;font-size:11px;font-weight:700;color:#6B6B78;text-transform:uppercase;letter-spacing:.07em">Descripción</td></tr>
          <tr><td style="padding:10px 14px;background:#FDF0F2;font-size:15px;font-weight:600;color:#9B1B30;border-radius:0 0 8px 8px;margin-bottom:12px">${descripcion}</td></tr>
        </table>
        <div style="height:12px"></div>
        <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden">
          ${hora ? `<tr><td style="padding:10px 14px;background:#F0EEE9;font-size:12px;color:#6B6B78;font-weight:600;width:120px">Hora</td><td style="padding:10px 14px;background:#F0EEE9;font-size:13px;color:#1B1B20;font-weight:700">${hora} hrs</td></tr>` : ''}
          ${fecha ? `<tr><td style="padding:10px 14px;background:#fff;font-size:12px;color:#6B6B78;font-weight:600">Fecha</td><td style="padding:10px 14px;background:#fff;font-size:13px;color:#1B1B20">${fecha}</td></tr>` : ''}
          ${origen ? `<tr><td style="padding:10px 14px;background:#F0EEE9;font-size:12px;color:#6B6B78;font-weight:600">Origen</td><td style="padding:10px 14px;background:#F0EEE9;font-size:13px;color:#1B1B20">${origen}</td></tr>` : ''}
          ${destino ? `<tr><td style="padding:10px 14px;background:#fff;font-size:12px;color:#6B6B78;font-weight:600">Destino</td><td style="padding:10px 14px;background:#fff;font-size:13px;color:#1B1B20">${destino}</td></tr>` : ''}
        </table>
        <div style="margin-top:24px;padding:14px;background:#FEF08A;border-radius:8px;border-left:3px solid #EAB308;font-size:12px;color:#854D0E">
          Estado inicial: <strong>PENDIENTE</strong> — recuerda actualizar el estado al iniciar y completar la ruta.
        </div>
        <div style="margin-top:24px;font-size:11px;color:#6B6B78;text-align:center">ObraControl CMI · Sistema de Inventario y Logística</div>
      </div>
    </div>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'ObraControl CMI <onboarding@resend.dev>',
        to: [to],
        subject: `🚛 Ruta asignada: ${descripcion}`,
        html
      })
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(400).json(data);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/send-report', async (req, res) => {
  const { to, fecha, totalItems, totalProjects, lowStock=[], noOp=[], summary=[] } = req.body;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return res.status(500).json({ error: 'Sin API key' });

  const sumRows = summary.map(p=>`<tr><td style="padding:8px 14px;border-bottom:1px solid #E2E1DE;font-size:13px;color:#1B1B20">${p.name}</td><td style="padding:8px 14px;border-bottom:1px solid #E2E1DE;font-size:13px;font-weight:700;color:#1B1B20;text-align:right">${p.count}</td></tr>`).join('');
  const lowRows = lowStock.length===0
    ? '<p style="color:#6B6B78;font-size:13px;padding:8px 0">Sin alertas de stock bajo ✓</p>'
    : lowStock.map(i=>`<div style="padding:6px 0;border-bottom:1px solid #F0EEE9;font-size:13px;color:#1B1B20"><b>${i.name}</b> — <span style="color:#D97706">Qty: ${i.quantity} / Mín: ${i.minStock}</span></div>`).join('');
  const noOpRows = noOp.length===0
    ? '<p style="color:#6B6B78;font-size:13px;padding:8px 0">Sin equipos no operativos ✓</p>'
    : noOp.map(i=>`<div style="padding:6px 0;border-bottom:1px solid #F0EEE9;font-size:13px;color:#DC2626"><b>${i.name}</b></div>`).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#9B1B30;padding:24px 28px;border-radius:12px 12px 0 0">
        <div style="color:#fff;font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;opacity:.7">CMI Construction Corp</div>
        <div style="color:#fff;font-size:22px;font-weight:700;margin-top:4px">Reporte de Inventario</div>
        <div style="color:#fff;font-size:13px;opacity:.8;margin-top:4px">${fecha}</div>
      </div>
      <div style="background:#fff;border:1px solid #E2E1DE;border-top:none;padding:28px;border-radius:0 0 12px 12px">
        <div style="display:flex;gap:16px;margin-bottom:24px">
          <div style="flex:1;background:#F0EEE9;border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:#9B1B30">${totalItems}</div>
            <div style="font-size:11px;color:#6B6B78;font-weight:600;text-transform:uppercase">Artículos</div>
          </div>
          <div style="flex:1;background:#F0EEE9;border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:#1D4ED8">${totalProjects}</div>
            <div style="font-size:11px;color:#6B6B78;font-weight:600;text-transform:uppercase">Proyectos</div>
          </div>
          <div style="flex:1;background:${lowStock.length>0?'#FEF3C7':'#F0EEE9'};border-radius:10px;padding:14px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:${lowStock.length>0?'#D97706':'#166534'}">${lowStock.length}</div>
            <div style="font-size:11px;color:#6B6B78;font-weight:600;text-transform:uppercase">Stock Bajo</div>
          </div>
        </div>
        <h3 style="font-size:14px;font-weight:700;color:#1B1B20;margin:0 0 10px">Artículos por Proyecto</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px">${sumRows}</table>
        <h3 style="font-size:14px;font-weight:700;color:#D97706;margin:0 0 10px">⚠ Stock Bajo</h3>
        <div style="margin-bottom:20px">${lowRows}</div>
        <h3 style="font-size:14px;font-weight:700;color:#DC2626;margin:0 0 10px">🔴 No Operativos</h3>
        <div>${noOpRows}</div>
        <div style="margin-top:28px;font-size:11px;color:#6B6B78;text-align:center">ObraControl CMI · Reporte generado automáticamente</div>
      </div>
    </div>`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method:'POST',
      headers:{ 'Authorization':`Bearer ${RESEND_KEY}`, 'Content-Type':'application/json' },
      body: JSON.stringify({ from:'ObraControl CMI <onboarding@resend.dev>', to:[to], subject:`📊 Reporte de Inventario CMI — ${fecha}`, html })
    });
    const data = await resp.json();
    if(!resp.ok) return res.status(400).json(data);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`CMI Logistica running on port ${PORT}`);
});
