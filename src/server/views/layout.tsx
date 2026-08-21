import type { JSX } from 'hono/jsx/jsx-runtime';

export type NavKey = 'home' | 'queue' | 'audit' | 'rubric' | 'about';

export interface ShellOptions {
  /** Shown in the tab and as the OG title. The wordmark is appended, never typed in by a page. */
  title: string;
  description: string;
  current: NavKey;
  /** Where the Queue nav item points from this page: the project in hand, or the primary one. */
  queueHref: string;
  /** The bar's right slot: the run metadata this page is about. */
  meta: string;
  canonical: string;
  body: JSX.Element;
  /** A page that has something to enhance names its own script. No page ships one it does not use. */
  script?: string;
}

const WORDMARK = 'bumpwarden';

function fullTitle(title: string): string {
  return title === WORDMARK ? WORDMARK : `${title} - ${WORDMARK}`;
}

interface NavItem {
  key: NavKey;
  label: string;
  href: string;
}

function navItems(queueHref: string): NavItem[] {
  return [
    { key: 'home', label: 'Home', href: '/' },
    { key: 'queue', label: 'Queue', href: queueHref },
    { key: 'audit', label: 'Audit', href: '/audit' },
    { key: 'rubric', label: 'Rubric', href: '/rubric' },
    { key: 'about', label: 'About', href: '/about' },
  ];
}

/**
 * Every page is this shell plus one body. The head is assembled here so no page can ship without a
 * title, a description or a canonical url, all three of which a judge reading the submission sees
 * before they see the design.
 */
export function Shell(options: ShellOptions): JSX.Element {
  const title = fullTitle(options.title);

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={options.description} />
        <link rel="canonical" href={options.canonical} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content={WORDMARK} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={options.description} />
        <meta property="og:url" content={options.canonical} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content={title} />
        <meta name="twitter:description" content={options.description} />
        <link
          rel="preload"
          href="/fonts/mona-sans-latin.woff2"
          as="font"
          type="font/woff2"
          crossorigin="anonymous"
        />
        <link rel="stylesheet" href="/bumpwarden.css" />
      </head>
      <body>
        <a class="skip" href="#main">
          Skip to the content
        </a>
        <header class="bar">
          <a class="logo" href="/">
            {WORDMARK}
          </a>
          <nav aria-label="Sections">
            {navItems(options.queueHref).map((item) => (
              <a
                key={item.key}
                href={item.href}
                {...(item.key === options.current ? { 'aria-current': 'page' } : {})}
              >
                {item.label}
              </a>
            ))}
          </nav>
          <span class="right">{options.meta}</span>
        </header>
        <main id="main">{options.body}</main>
        {options.script ? <script src={options.script} defer type="module" /> : null}
      </body>
    </html>
  );
}
