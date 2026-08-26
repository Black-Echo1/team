import React from "react";
import ReactDOM from "react-dom/client";
import DubbingStudio from "./DubbingStudio.jsx";

const style = document.createElement("style");
style.textContent = `
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  /* Stack the studio layout vertically on narrow (phone) screens: video on
     top, character/progress panel underneath, full width, instead of the
     two-column side-by-side layout used on wider screens. */
  @media (max-width: 720px) {
    .studio-wrap {
      flex-direction: column !important;
    }
    .studio-sidebar {
      width: 100% !important;
      order: 2;
    }
    .studio-main {
      order: 1;
    }
  }
`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DubbingStudio />
  </React.StrictMode>
);
