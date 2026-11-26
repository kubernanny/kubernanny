import { Share } from '@capacitor/share';

export type ShareOutcome = 'shared' | 'copied' | 'failed';

export interface ShareApi {
  canShare(): Promise<boolean>;
  share(text: string, title: string): Promise<void>;
  copy(text: string): Promise<void>;
}

/** The system share sheet (Capacitor Share: native, or the Web Share API) and the clipboard. */
const SYSTEM: ShareApi = {
  canShare: async () => (await Share.canShare()).value,
  share: async (text, title) => {
    await Share.share({ text, title, dialogTitle: title });
  },
  copy: async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      copyWithSelection(text);
    }
  },
};

/**
 * The Clipboard API exists only on secure origins; an agent's web UI over
 * plain http in the LAN is not one. Selecting a hidden textarea still copies there.
 */
function copyWithSelection(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) {
    throw new Error('copy refused');
  }
}

/** Copies text to the clipboard, also on an insecure origin; false when the browser refused. */
export async function copyText(
  text: string,
  api: Pick<ShareApi, 'copy'> = SYSTEM,
): Promise<boolean> {
  try {
    await api.copy(text);
    return true;
  } catch {
    return false;
  }
}

/** The person closed the share sheet: that is an answer, not a reason to copy instead. */
function cancelled(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /cancel/i.test(err.message));
}

/**
 * Shares text where the platform can, else copies it. Desktop browsers
 * without the Web Share API, and insecure origins (an agent's web UI over
 * plain http) end up on the clipboard.
 */
export async function shareText(
  text: string,
  title: string,
  api: ShareApi = SYSTEM,
): Promise<ShareOutcome> {
  try {
    if (await api.canShare()) {
      await api.share(text, title);
      return 'shared';
    }
  } catch (err) {
    if (cancelled(err)) {
      return 'shared';
    }
  }
  return (await copyText(text, api)) ? 'copied' : 'failed';
}
