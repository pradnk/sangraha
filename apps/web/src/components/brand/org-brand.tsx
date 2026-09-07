/**
 * The organisation's identity, wherever it appears.
 *
 * The whole point of this component is that the NGO is front and centre and
 * Sangraha recedes. A worker should feel they are using their organisation's
 * system, not a product someone handed them.
 *
 * Falls back to the organisation's name set in type when there is no logo —
 * never to a Sangraha mark, and never to an empty space. A great many small
 * NGOs have no usable logo file, and their name in clear type looks
 * deliberate, whereas a gap looks broken.
 */
export interface OrgIdentity {
  name: string;
  slug: string;
  /** Timestamp of the current logo, or null when there is none. */
  logoStamp: number | null;
}

export function OrgBrand({
  org,
  size = 'md',
  className = '',
}: {
  org: OrgIdentity;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const dimensions = {
    sm: { box: 'h-7', text: 'text-sm' },
    md: { box: 'h-9', text: 'text-base' },
    lg: { box: 'h-16', text: 'text-2xl' },
  }[size];

  if (org.logoStamp) {
    return (
      <span className={`flex items-center gap-2.5 ${className}`}>
        {/* Plain <img>: the logo is arbitrary user-uploaded bytes from our own
            API route, so there is nothing for the image optimiser to do and a
            sizing mistake would distort someone's brand. `object-contain` keeps
            wide and square logos both intact. */}
        {/* `title` as well as `alt`: a logo is a picture of a name, and a
            reader who does not recognise it has no way to ask. `alt` answers
            that for a screen reader and for a broken image, but a sighted
            person hovering sees nothing — browsers stopped surfacing `alt` as
            a tooltip long ago. This matters most where it is least obvious:
            somebody supporting several NGOs, or looking at a screenshot, who
            cannot tell whose installation they are in. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/orgs/${encodeURIComponent(org.slug)}/logo?v=${org.logoStamp}`}
          alt={org.name}
          title={org.name}
          className={`${dimensions.box} w-auto max-w-[200px] object-contain`}
        />
      </span>
    );
  }

  return (
    <span className={`font-semibold text-slate-900 ${dimensions.text} ${className}`}>
      {org.name}
    </span>
  );
}
