import React from "react";
import ReactDOM from "react-dom/client";

import "../index.css";
import { LabApp } from "./LabApp";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Base3Router UI Lab is missing #root.");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <LabApp />
  </React.StrictMode>,
);
