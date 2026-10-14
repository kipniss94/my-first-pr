import type { Metadata } from 'next';
import { safeNext } from '@/lib/access';

export const metadata: Metadata = { title: 'Access code — DocuView', robots: { index: false } };
export const dynamic = 'force-dynamic';

const MESSAGES: Record<string, string> = {
  wrong: 'That code is not right. It is shown in the DocuView window on the computer running it.',
  wait: 'Too many tries. Wait ten minutes and try again.',
};

export default async function AccessPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const error = params.error ? MESSAGES[params.error] : null;

  return (
    <main className="grid min-h-dvh place-items-center bg-ink-900 px-4">
      <form
        method="post"
        action="/access/verify"
        className="w-full max-w-sm rounded-2xl border border-line bg-ink-850 p-6 shadow-xl"
      >
        <h1 className="text-lg font-semibold text-mist-100">DocuView</h1>
        <p className="mt-1 text-sm text-mist-400">Enter the access code shown in the DocuView window on the computer that runs it.</p>
        <input type="hidden" name="next" value={next} />
        <label className="mt-5 block">
          <span className="field-label">Access code</span>
          <input
            name="code"
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            className="mt-1.5 w-full rounded-lg border border-line bg-ink-900 px-3 py-2.5 font-mono text-lg uppercase tracking-[0.2em] text-mist-100 outline-none focus:border-accent"
            data-testid="access-code"
          />
        </label>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary mt-5 w-full justify-center" data-testid="access-submit">
          Open DocuView
        </button>
      </form>
    </main>
  );
}
