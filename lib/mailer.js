const nodemailer = require("nodemailer");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendNewMatchesAlert({ to, matchCount, breakdown, scanTime }) {
  const breakdownRows = Object.entries(breakdown)
    .filter(([, count]) => count > 0)
    .map(
      ([source, count]) =>
        `<tr>
          <td style="padding:8px 14px;border-bottom:1px solid #eee;color:#333">${source}</td>
          <td style="padding:8px 14px;border-bottom:1px solid #eee;text-align:center">
            <span style="background:#FDECEA;color:#B22222;padding:2px 10px;border-radius:10px;font-size:13px;font-weight:bold">${count} new</span>
          </td>
        </tr>`
    )
    .join("");

  const html = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f4f6f9;">

  <!-- Header -->
  <div style="background:#E3000F;padding:20px 24px;display:flex;align-items:center;gap:12px;">
    <div style="width:36px;height:36px;background:#fff;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-weight:bold;font-size:16px;color:#E3000F;text-align:center;line-height:36px;vertical-align:middle;">G</div>
    <span style="color:#fff;font-size:20px;font-weight:bold;vertical-align:middle;margin-left:10px;">GoBeagleGo Alert</span>
  </div>

  <!-- Body -->
  <div style="background:#fff;padding:28px 24px;">
    <h2 style="color:#1B2A4A;margin:0 0 8px;font-size:22px;">New Trademark Matches Found</h2>
    <p style="color:#555;margin:0 0 24px;font-size:15px;">
      Your daily scan completed at <strong>${scanTime} UTC</strong> and detected
      <strong style="color:#E3000F">${matchCount} new match${matchCount !== 1 ? "es" : ""}</strong>.
    </p>

    ${
      breakdownRows
        ? `<table style="width:100%;border-collapse:collapse;margin-bottom:24px;border:1px solid #eee;border-radius:6px;overflow:hidden;">
            <thead>
              <tr style="background:#f4f6f9;">
                <th style="padding:10px 14px;text-align:left;font-size:11px;color:#888;letter-spacing:1px;font-weight:bold;">SOURCE</th>
                <th style="padding:10px 14px;text-align:center;font-size:11px;color:#888;letter-spacing:1px;font-weight:bold;">NEW MATCHES</th>
              </tr>
            </thead>
            <tbody>${breakdownRows}</tbody>
          </table>`
        : ""
    }

    <a href="https://gobeaglego.com" style="display:inline-block;background:#E3000F;color:#fff;text-decoration:none;padding:13px 28px;border-radius:6px;font-weight:bold;font-size:15px;">
      View Dashboard &rarr;
    </a>
  </div>

  <!-- Footer -->
  <div style="background:#f9f9f9;padding:14px 24px;border-top:1px solid #eee;">
    <p style="color:#bbb;font-size:12px;margin:0;">
      GoBeagleGo &mdash; Trademark Monitoring &nbsp;&middot;&nbsp;
      <a href="https://gobeaglego.com/settings" style="color:#bbb;text-decoration:underline;">Manage alerts</a>
    </p>
  </div>

</div>`;

  await transporter.sendMail({
    from: `"GoBeagleGo" <${process.env.SMTP_USER}>`,
    to,
    subject: `${matchCount} New Trademark Match${matchCount !== 1 ? "es" : ""} Found — GoBeagleGo`,
    html,
  });
}

async function sendScheduledScanReport({
  to,
  pdf,
  filename,
  scanTime,
  matchCount,
  breakdown,
  scanErrors = {},
}) {
  const breakdownRows = Object.entries(breakdown)
    .map(([source, count]) => `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#333">${source}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;font-weight:bold">${count}</td>
    </tr>`)
    .join('');
  const errorCount = Object.keys(scanErrors).length;

  const html = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;background:#f4f6f9">
    <div style="background:#E3000F;padding:20px 24px;color:#fff;font-size:20px;font-weight:bold">GoBeagleGo Scan Report</div>
    <div style="background:#fff;padding:28px 24px">
      <h2 style="color:#1B2A4A;margin:0 0 8px">Scheduled scan completed</h2>
      <p style="color:#555;line-height:1.6;margin:0 0 18px">The scheduled monitoring scan completed at <strong>${scanTime} UTC</strong>. The attached PDF contains the current status of monitored keywords and all available trademark, domain, marketplace, and social matches.</p>
      <div style="background:${matchCount > 0 ? '#FDECEA' : '#D4EDDA'};color:${matchCount > 0 ? '#B22222' : '#1E7A4A'};padding:12px 14px;border-radius:6px;font-weight:bold;margin-bottom:18px">
        ${matchCount > 0 ? `${matchCount} new potential match${matchCount === 1 ? '' : 'es'} found during this scan.` : 'No new potential matches were found during this scan.'}
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:18px"><thead><tr style="background:#1B2A4A;color:#fff"><th style="padding:9px 12px;text-align:left">Source</th><th style="padding:9px 12px">New</th></tr></thead><tbody>${breakdownRows}</tbody></table>
      ${errorCount ? `<p style="color:#B22222;font-size:13px"><strong>Scanner notice:</strong> ${errorCount} scanner${errorCount === 1 ? '' : 's'} reported an error. Available results are still included in the report.</p>` : ''}
      <p style="color:#777;font-size:12px;line-height:1.5;margin-top:18px">Items marked for attention are monitoring alerts and require review; they are not confirmed legal threats.</p>
      <a href="https://gobeaglego.com" style="display:inline-block;background:#E3000F;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold;margin-top:12px">View Dashboard</a>
    </div>
  </div>`;

  await transporter.sendMail({
    from: `"GoBeagleGo" <${process.env.SMTP_USER}>`,
    to,
    subject: `Trademark Monitoring Report — ${matchCount} New Match${matchCount === 1 ? '' : 'es'}`,
    html,
    attachments: [{ filename, content: pdf, contentType: 'application/pdf' }],
  });
}

module.exports = { sendNewMatchesAlert, sendScheduledScanReport };
