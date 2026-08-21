import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-3xl grow flex-col justify-center px-5 py-20 sm:px-8">
      <p className="text-sm font-medium text-accent">404</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        We couldn&apos;t find that page
      </h1>
      <p className="mt-4 max-w-md text-base leading-relaxed text-ink-muted">
        The link may be wrong, or the page may have moved. There is only one page
        here anyway — the build plan generator.
      </p>
      <Link
        href="/"
        className="mt-8 inline-flex min-h-11 w-fit items-center rounded-xl bg-accent px-5 text-[15px] font-semibold text-accent-ink transition-opacity hover:opacity-90"
      >
        Back to the generator
      </Link>
    </main>
  );
}
