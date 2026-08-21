import type { JSX } from 'hono/jsx/jsx-runtime';
import { safeHref } from '../view-model.js';

export interface LinkedProps {
  href: string | null | undefined;
  label: string;
  class?: string;
}

/**
 * The one way a page turns a stored url into a link. Every url on this dashboard was received from
 * somewhere: GitHub's API, a deps.dev advisory, the agent's answer about a stranger's release
 * notes. `safeHref` decides whether it may be clicked; the label is printed either way, so a
 * refused scheme costs a reader the link and not the fact.
 */
export function Linked(props: LinkedProps): JSX.Element {
  const href = safeHref(props.href);
  if (!href) return <span class={props.class ?? 'plain'}>{props.label}</span>;

  return (
    <a class={props.class ?? 'plain'} href={href} rel="noreferrer">
      {props.label}
    </a>
  );
}
