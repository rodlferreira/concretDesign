import nodemailer from "nodemailer";
export function createNotifier(repository) {
  if (!process.env.SMTP_HOST) return { flush: async () => {} };
  if (
    !process.env.SMTP_USER ||
    !process.env.SMTP_PASSWORD ||
    !process.env.SMTP_FROM
  )
    throw new Error("SMTP credentials and sender are required");
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== "false",
    requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 10000,
    socketTimeout: 15000,
  });
  let running = false;
  return {
    async flush() {
      if (running) return;
      running = true;
      try {
        for (const { id, data } of repository.pending()) {
          const { email, ...fields } = data;
          await transport.sendMail({
            from: process.env.SMTP_FROM,
            to: process.env.QUOTE_EMAIL || "geral@concretdesign.pt",
            replyTo: email,
            subject: `ConcretDesign | Pedido ${id}`,
            text:
              `Referência: ${id}\nEmail: ${email}\n` +
              Object.entries(fields)
                .map(([key, value]) => `${key}: ${value}`)
                .join("\n"),
          });
          repository.markNotified(id);
        }
      } catch (error) {
        console.error("Quote notification failed:", error.code || error.name);
      } finally {
        running = false;
      }
    },
  };
}
