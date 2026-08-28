import React from "react";
import ReactDOM from "react-dom/client";
import DubbingStudio from "./DubbingStudio.jsx";

const style = document.createElement("style");
style.textContent = `
  @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=JetBrains+Mono:wght@400;600;700&family=Tajawal:wght@400;500;700&display=swap');

  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes onairBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  @keyframes onairPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(232,72,58,0.35); }
    50% { box-shadow: 0 0 0 6px rgba(232,72,58,0); }
  }

  * { box-sizing: border-box; }
  body { margin: 0; }
  button:focus-visible, select:focus-visible, input:focus-visible, a:focus-visible {
    outline: 2px solid #E8483A;
    outline-offset: 2px;
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
  }

  /* Studio layout: sidebar + main panel side-by-side on wide screens.
     On phones, stack them — video/sidebar on top, the recording panel
     (timeline + controls) below at full width so it has room to breathe. */
  .studio-wrap {
    display: flex;
    gap: 16px;
    width: 100%;
    max-width: 900px;
  }
  .studio-sidebar {
    width: 220px;
    flex-shrink: 0;
  }
  .studio-main {
    flex: 1;
    min-width: 0; /* prevents flex children (like the waveform canvas) from overflowing */
  }
  @media (max-width: 760px) {
    .studio-wrap {
      flex-direction: column;
    }
    .studio-sidebar {
      width: 100%;
      order: 1;
    }
    .studio-video-block {
      order: 2;
    }
    .studio-record-block {
      order: 3;
      width: 100%;
    }
  }
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DubbingStudio />
  </React.StrictMode>
);
