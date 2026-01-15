import type * as React from "react";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "gpx-viewer": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

export {};

