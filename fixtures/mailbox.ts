import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// Polls the dedicated Gmail test account (lumid-e2e@lum.id) over IMAP
// for messages sent BY lum.id. Each test uses a `+subaddress` tag in
// its signup/forgot-password email so concurrent runs never collide —
// Gmail routes `lumid-e2e+anything@lum.id` to the same mailbox and IMAP
// `TO` search filters it back out.
//
// Returns either a 6-digit OTP (from the verification-code template)
// or the reset-token extracted from the reset-password link.

const GMAIL_USER = process.env.E2E_GMAIL_USER;
const GMAIL_PASS = process.env.E2E_GMAIL_APP_PASSWORD;
const GMAIL_HOST = process.env.E2E_GMAIL_HOST || "imap.gmail.com";
const GMAIL_PORT = Number(process.env.E2E_GMAIL_PORT || 993);

function requireCreds(): void {
	if (!GMAIL_USER || !GMAIL_PASS) {
		throw new Error(
			"E2E_GMAIL_USER / E2E_GMAIL_APP_PASSWORD not set — see .env.example",
		);
	}
}

/**
 * Compose an inbox address with a `+tag` suffix so the test's emails
 * are uniquely identifiable. Gmail preserves the tag in the TO header.
 */
export function taggedAddress(tag: string): string {
	requireCreds();
	const [local, domain] = GMAIL_USER!.split("@");
	const safeTag = tag.replace(/[^a-zA-Z0-9_-]/g, "-");
	return `${local}+${safeTag}@${domain}`;
}

async function openInbox(): Promise<ImapFlow> {
	requireCreds();
	const client = new ImapFlow({
		host: GMAIL_HOST,
		port: GMAIL_PORT,
		secure: true,
		auth: { user: GMAIL_USER!, pass: GMAIL_PASS! },
		logger: false,
	});
	await client.connect();
	await client.mailboxOpen("INBOX");
	return client;
}

/**
 * Poll the mailbox for the most recent message matching `to:`.
 * Returns the parsed HTML body + subject. Times out at `timeoutMs`.
 */
export async function waitForEmail(
	to: string,
	opts: { timeoutMs?: number; pollMs?: number; sinceSeconds?: number } = {},
): Promise<{ subject: string; html: string; text: string }> {
	const timeoutMs = opts.timeoutMs ?? 90_000;
	const pollMs = opts.pollMs ?? 2_000;
	const sinceSeconds = opts.sinceSeconds ?? 180;

	const since = new Date(Date.now() - sinceSeconds * 1000);
	const deadline = Date.now() + timeoutMs;
	let client: ImapFlow | null = null;

	try {
		while (Date.now() < deadline) {
			client = await openInbox();
			// IMAP search: delivered SINCE <date>, TO <tagged>
			const uids = await client.search({ to, since });
			if (uids && uids.length > 0) {
				// Fetch the newest match.
				const uid = uids[uids.length - 1];
				const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
				if (msg && msg.source) {
					const parsed = await simpleParser(msg.source);
					await client.logout();
					return {
						subject: parsed.subject || "",
						html: typeof parsed.html === "string" ? parsed.html : "",
						text: parsed.text || "",
					};
				}
			}
			await client.logout();
			client = null;
			await new Promise((r) => setTimeout(r, pollMs));
		}
	} finally {
		if (client) {
			try { await client.logout(); } catch { /* ignore */ }
		}
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for email to ${to}`);
}

/**
 * Pull a 6-digit OTP from a verification-code email body. The Go
 * handler renders the OTP inside a styled <div class="code">…</div>
 * — we scan for any standalone 6-digit run as a fallback.
 */
export function extractOtp(html: string, text: string): string {
	const body = html + "\n" + text;
	// Primary: 6 digits in a row that look like an OTP
	const m = body.match(/\b(\d{6})\b/);
	if (!m) throw new Error("No 6-digit OTP found in email body");
	return m[1];
}

/**
 * Pull the reset-password token from the link in the reset email.
 * Link format: https://lum.id/auth/reset-password?token=<hex>
 */
export function extractResetToken(html: string, text: string): string {
	const body = html + "\n" + text;
	const m = body.match(/reset-password\?token=([A-Fa-f0-9]+)/);
	if (!m) throw new Error("No reset-password token found in email body");
	return m[1];
}
