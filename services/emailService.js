import nodemailer from "nodemailer";
import { pool } from "./databaseService.js";
import { decryptCredentials } from "./credentialCryptoService.js";

function messageText(content) {
  if (typeof content === "string") return content;

  const parts = [content?.message || ""];
  if (Array.isArray(content?.products) && content.products.length) {
    parts.push(
      "Products mentioned:",
      ...content.products.map(product => `- ${product.name}`)
    );
  }

  return parts.filter(Boolean).join("\n");
}

export async function sendConversationTranscript(storeId, conversationId) {
  const result = await pool.query(
    `SELECT
       c.ended_at,
       c.transcript_sent_at,
       c.transcript_send_status,
       s.name AS store_name,
       l.name AS customer_name,
       l.email AS customer_email,
       l.consent_to_contact
     FROM conversations c
     JOIN stores s ON s.id = c.store_id
     LEFT JOIN leads l ON l.conversation_id = c.id
     WHERE c.id = $1 AND c.store_id = $2`,
    [conversationId, storeId]
  );

  const conversation = result.rows[0];
  if (!conversation) throw new Error("Conversation not found.");
  if (!conversation.ended_at) throw new Error("Conversation has not ended.");

  if (
    !conversation.customer_email ||
    !conversation.consent_to_contact ||
    conversation.transcript_sent_at
  ) {
    return { sent: false };
  }

  const claim = await pool.query(
    `UPDATE conversations
     SET transcript_send_status = 'sending'
     WHERE id = $1
       AND store_id = $2
       AND transcript_sent_at IS NULL
       AND transcript_send_status IN ('pending', 'failed')
     RETURNING id`,
    [conversationId, storeId]
  );

  if (claim.rowCount === 0) return { sent: false };

  try {
    const smtpResult = await pool.query(
      `SELECT credentials_encrypted
       FROM store_integrations
       WHERE store_id = $1 AND platform = 'smtp'`,
      [storeId]
    );

    if (!smtpResult.rows[0]) {
      throw new Error("SMTP settings are not configured for this store.");
    }

    const smtp = decryptCredentials(smtpResult.rows[0].credentials_encrypted);

    const messagesResult = await pool.query(
      `SELECT role, content, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [conversationId]
    );

    const transcript = messagesResult.rows.map(message => {
      const speaker = message.role === "assistant"
        ? "Sai"
        : conversation.customer_name || "Customer";
      return `${speaker}:\n${messageText(message.content)}`;
    }).join("\n\n");

    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: Number(smtp.port),
      secure: Boolean(smtp.secure),
      requireTLS: !smtp.secure,
      auth: {
        user: smtp.username,
        pass: smtp.password
      }
    });

    await transporter.sendMail({
      from: { name: smtp.fromName, address: smtp.fromEmail },
      to: conversation.customer_email,
      subject: `Your chat with ${conversation.store_name}`,
      text:
        `Hi ${conversation.customer_name || "there"},\n\n` +
        `Here is the transcript you requested from ${conversation.store_name}.\n\n` +
        `${transcript}\n\n` +
        `Regards,\n${conversation.store_name}`
    });

    await pool.query(
      `UPDATE conversations
       SET transcript_send_status = 'sent',
           transcript_sent_at = NOW()
       WHERE id = $1 AND store_id = $2`,
      [conversationId, storeId]
    );

    return { sent: true };
  } catch (error) {
    await pool.query(
      `UPDATE conversations
       SET transcript_send_status = 'failed'
       WHERE id = $1 AND store_id = $2`,
      [conversationId, storeId]
    );
    throw error;
  }
}