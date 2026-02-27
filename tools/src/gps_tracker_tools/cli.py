"""
Unified CLI entry point for gps_tracker tools.

Commands:
    gt fetch       - Unified location query (Apple + Google), merge, GPX export
    gt findmy      - Apple Find My subcommands
    gt fmdn        - Google FMDN subcommands
    gt casic       - CASIC protocol parser
    gt gps         - GPS binary format tools
    gt uf2         - UF2 firmware build
"""

import argparse
import json
import sys

from gps_tracker_tools import findmy, fmdn, casic, gps_format, uf2
from gps_tracker_tools.findmy import DEFAULT_ANISETTE_URL, DEFAULT_AUTH_PATH
from gps_tracker_tools.fmdn_fetch import DEFAULT_TOKEN_CACHE
from gps_tracker_tools.gpx import dedupe_reports, reports_to_gpx, write_gpx


def cmd_fetch(args):
    """Unified location fetch: pull from Apple and/or Google, merge, export."""
    all_results = []

    # Apple Find My
    if args.source in ("apple", "both"):
        if not args.findmy_keys:
            if args.source == "apple":
                print(
                    "Error: --findmy-keys is required for Apple source",
                    file=sys.stderr,
                )
                sys.exit(1)
        else:
            print("=== Fetching Apple Find My reports ===")
            # Build a namespace compatible with findmy.cmd_fetch
            apple_args = argparse.Namespace(
                keyfile=args.findmy_keys,
                private_key=None,
                symmetric_key=None,
                epoch=None,
                hours=args.hours,
                auth=args.auth,
                anisette_url=args.anisette_url,
                output=None,
                gpx=None,
            )
            try:
                results = findmy.cmd_fetch(apple_args)
                if results:
                    for r in results:
                        r["source"] = "apple"
                    all_results.extend(results)
                    print(
                        f"Apple: {len(results)} locations",
                        file=sys.stderr,
                    )
            except Exception as e:
                print(
                    f"Apple fetch failed: {e}", file=sys.stderr
                )

    # Google FMDN
    if args.source in ("google", "both"):
        if not args.fmdn_keys:
            if args.source == "google":
                print(
                    "Error: --fmdn-keys is required for Google source",
                    file=sys.stderr,
                )
                sys.exit(1)
        else:
            print("\n=== Fetching Google FMDN reports ===")
            fmdn_args = argparse.Namespace(
                keys=args.fmdn_keys,
                hours=args.hours,
                token_cache=args.token_cache,
                output=None,
                gpx=None,
            )
            try:
                results = fmdn.cmd_fetch(fmdn_args)
                if results:
                    for r in results:
                        r["source"] = "google"
                    all_results.extend(results)
                    print(
                        f"Google: {len(results)} locations",
                        file=sys.stderr,
                    )
            except Exception as e:
                print(
                    f"Google fetch failed: {e}", file=sys.stderr
                )

    if not all_results:
        print("\nNo location reports found from any source.")
        return

    # Sort by timestamp
    all_results.sort(key=lambda r: r["timestamp"])

    # Dedupe across sources
    deduped = dedupe_reports(all_results)

    print(f"\n=== Combined Results ===")
    print(f"Total: {len(all_results)} raw -> {len(deduped)} deduped")

    for r in deduped:
        src = r.get("source", "?")
        dt = r.get("datetime", "?")
        print(
            f"  [{src:6s}] {dt}  "
            f"({r['lat']:.6f}, {r['lon']:.6f})"
        )

    if args.output:
        with open(args.output, "w") as f:
            json.dump(deduped, f, indent=2)
        print(f"\nResults saved to {args.output}")

    if args.gpx:
        write_gpx(deduped, args.gpx, dedupe=False)


def main():
    parser = argparse.ArgumentParser(
        prog="gt",
        description="GPS Tracker Tools - unified CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Examples:
  gt fetch --findmy-keys keys.json --fmdn-keys eik.json --gpx track.gpx
  gt findmy fetch -k keys.json -H 24 --gpx track.gpx
  gt fmdn keys -k eik.json -H 24
  gt casic parse data.bin -v
  gt gps decode input.bin output.json
  gt uf2 build
""",
    )
    sub = parser.add_subparsers(dest="command")

    # --- fetch (unified) ---
    p_fetch = sub.add_parser(
        "fetch",
        help="Unified location fetch (Apple + Google)",
    )
    p_fetch.add_argument(
        "--source",
        choices=["apple", "google", "both"],
        default="both",
        help="Location source (default: both)",
    )
    p_fetch.add_argument(
        "--findmy-keys",
        help="Apple Find My key material JSON file",
    )
    p_fetch.add_argument(
        "--fmdn-keys",
        help="Google FMDN EIK JSON file",
    )
    p_fetch.add_argument(
        "-H",
        "--hours",
        type=int,
        default=24,
        help="Hours to look back (default: 24)",
    )
    p_fetch.add_argument(
        "--auth",
        default=DEFAULT_AUTH_PATH,
        help=f"Apple auth.json path (default: {DEFAULT_AUTH_PATH})",
    )
    p_fetch.add_argument(
        "--anisette-url",
        default=DEFAULT_ANISETTE_URL,
        help=f"Anisette v3 server URL (default: {DEFAULT_ANISETTE_URL})",
    )
    p_fetch.add_argument(
        "--token-cache",
        default=DEFAULT_TOKEN_CACHE,
        help=f"Google token cache path (default: {DEFAULT_TOKEN_CACHE})",
    )
    p_fetch.add_argument(
        "--gpx",
        help="Export results as GPX file",
    )
    p_fetch.add_argument(
        "-o",
        "--output",
        help="Save results to JSON file",
    )
    p_fetch.set_defaults(func=cmd_fetch)

    # --- findmy ---
    p_findmy = sub.add_parser(
        "findmy",
        help="Apple Find My tools",
    )
    findmy_sub = p_findmy.add_subparsers(dest="findmy_command")
    findmy.add_subcommands(findmy_sub)

    # --- fmdn ---
    p_fmdn = sub.add_parser(
        "fmdn",
        help="Google FMDN tools",
    )
    fmdn_sub = p_fmdn.add_subparsers(dest="fmdn_command")
    fmdn.add_subcommands(fmdn_sub)

    # --- casic ---
    p_casic = sub.add_parser(
        "casic",
        help="CASIC protocol parser",
    )
    casic_sub = p_casic.add_subparsers(dest="casic_command")
    casic.add_subcommands(casic_sub)

    # --- gps ---
    p_gps = sub.add_parser(
        "gps",
        help="GPS binary format tools",
    )
    gps_sub = p_gps.add_subparsers(dest="gps_command")
    gps_format.add_subcommands(gps_sub)

    # --- uf2 ---
    p_uf2 = sub.add_parser(
        "uf2",
        help="UF2 firmware build tools",
    )
    uf2_sub = p_uf2.add_subparsers(dest="uf2_command")
    uf2.add_subcommands(uf2_sub)

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    if hasattr(args, "func"):
        result = args.func(args)
        if isinstance(result, int):
            sys.exit(result)
    else:
        # Print help for the subcommand if no sub-subcommand given
        for action in parser._subparsers._actions:
            if isinstance(action, argparse._SubParsersAction):
                if args.command in action.choices:
                    action.choices[args.command].print_help()
                    break
        sys.exit(1)


if __name__ == "__main__":
    main()
