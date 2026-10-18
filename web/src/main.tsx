import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppShell } from "@/components/AppShell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ReviewList } from "@/pages/ReviewList";
import { ReviewPage } from "@/pages/ReviewPage";
import "./index.css";

// shadcn's dark theme keys off a `dark` class on <html>.
if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.classList.add("dark");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <TooltipProvider>
        <AppShell>
          <Routes>
            <Route path="/" element={<ReviewList />} />
            <Route path="/reviews/:id" element={<ReviewPage />} />
          </Routes>
        </AppShell>
      </TooltipProvider>
    </BrowserRouter>
  </StrictMode>,
);
