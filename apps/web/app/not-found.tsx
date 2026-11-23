import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1 className="page-title">There is no page at this address</h1>
      <p className="lede">
        <Link href="/">See what is flowing now</Link>, or <Link href="/tokens/">browse the monitored tokens</Link>.
      </p>
    </>
  );
}
