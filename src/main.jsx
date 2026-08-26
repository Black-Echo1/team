import React from "react";
import ReactDOM from "react-dom/client";
import DubbingStudio from "./DubbingStudio.jsx";

const style = document.createElement("style");
style.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
document.head.appendChild(style);

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DubbingStudio />
  </React.StrictMode>
);
