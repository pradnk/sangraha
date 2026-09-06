import 'server-only';
import { finaliseTable, type SheetTable } from '@sangraha/form-engine';
import { googleAccessToken, readServiceAccount } from '@/lib/translation/service-account';

/**
 * Reading a Google Sheet, given its link.
 *
 * The point of accepting a link at all: an organisation that keeps its records
 * in Sheets does not have to remember to re-export a CSV every time. They paste
 * the address they already have open.
 *
 * Two ways in, tried in order:
 *
 *   1. **The service account**, if one is configured — the same credential the
 *      translation feature uses, with a read-only Sheets scope added. Works for
 *      a private sheet, provided it has been shared with the service account's
 *      address, which is the thing people forget and so is what the error says.
 *   2. **The API key**, which can only ever read a sheet that is public. Fine
 *      for a sheet already shared with "anyone with the link".
 */

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

/** The id out of any of the shapes a Sheets URL comes in. */
export function sheetIdFrom(url: string): string | null {
  const match = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.exec(url.trim());
  if (match) return match[1] ?? null;
  // Somebody may paste the bare id.
  return /^[a-zA-Z0-9-_]{20,}$/.test(url.trim()) ? url.trim() : null;
}

type Result = { ok: true; table: SheetTable; label: string } | { ok: false; error: string };

export async function readSheet(url: string): Promise<Result> {
  const id = sheetIdFrom(url);
  if (!id) {
    return {
      ok: false,
      error:
        'That does not look like a Google Sheets link. Copy the address from your browser while the sheet is open.',
    };
  }

  const auth = await sheetsAuth();
  if (!auth) {
    return {
      ok: false,
      error:
        'Reading Google Sheets is not set up on this installation. Download the sheet as a CSV and upload it instead, or ask your administrator to add a Google credential.',
    };
  }

  /*
   * The whole of the first sheet. `A:ZZZ` rather than naming a tab, because the
   * first tab's name is unknown and is frequently not "Sheet1" — and asking the
   * admin for it would be asking about something they should not have to know.
   */
  const endpoint = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/A:ZZZ`,
  );
  // Blank trailing cells are omitted by default, which would shift columns.
  endpoint.searchParams.set('majorDimension', 'ROWS');
  endpoint.searchParams.set('valueRenderOption', 'FORMATTED_VALUE');
  if (auth.kind === 'key') endpoint.searchParams.set('key', auth.value);

  const response = await fetch(endpoint, {
    headers: auth.kind === 'token' ? { Authorization: `Bearer ${auth.value}` } : {},
    cache: 'no-store',
  });

  if (!response.ok) {
    return { ok: false, error: sheetError(response.status, auth.kind) };
  }

  const body = (await response.json()) as { values?: string[][] };
  const grid = (body.values ?? []).map((row) => row.map((cell) => String(cell ?? '')));

  if (grid.length === 0) {
    return { ok: false, error: 'That sheet is empty.' };
  }

  return { ok: true, table: finaliseTable(grid, false), label: 'Google Sheet' };
}

async function sheetsAuth(): Promise<{ kind: 'token' | 'key'; value: string } | null> {
  const account = readServiceAccount();
  if (account) {
    try {
      return { kind: 'token', value: await googleAccessToken(account, SHEETS_SCOPE) };
    } catch {
      // Fall through to the key: a service account that cannot mint a Sheets
      // token is no use here, but a public sheet may still be readable.
    }
  }

  const key = process.env.GOOGLE_TRANSLATE_API_KEY?.trim();
  return key ? { kind: 'key', value: key } : null;
}

/** Says which of the two likely mistakes it was, rather than "403". */
function sheetError(status: number, via: 'token' | 'key'): string {
  if (status === 403 || status === 401) {
    return via === 'token'
      ? 'That sheet has not been shared with this installation. Open it in Google Sheets, choose Share, and give view access to the service account address in your Google credential.'
      : 'That sheet is not public. Either share it with "anyone with the link", or download it as a CSV and upload it here.';
  }
  if (status === 404) {
    return 'No sheet was found at that link. Check the address, and that the sheet has not been deleted.';
  }
  return 'Google Sheets could not be reached just now. Try again, or upload the file instead.';
}
