import { HttpAgent } from "@ag-ui/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { AppShell } from "@/components/AppShell";
import { ReviewList } from "@/pages/ReviewList";
import { ReviewPage } from "@/pages/ReviewPage";
import { createPageContext } from "@/lib/agents";
import { createApi } from "@/lib/api";
import { ServicesProvider, type Services } from "@/lib/services";
import "./index.css";

// shadcn's dark theme keys off a `dark` class on <html>.
if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.classList.add("dark");

// The api process (and Vite, in dev) serves /api and proxies /agent/* to the
// agent process, so everything is same-origin.
const services: Services = {
  chatAgent: new HttpAgent({ url: "/agent/" }),
  searchAgent: new HttpAgent({ url: "/agent/search" }),
  pageContext: createPageContext(),
  api: createApi("/api"),
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ServicesProvider services={services}>
      <BrowserRouter>
        <AppShell>
          <Routes>
            <Route path="/" element={<ReviewList />} />
            <Route path="/reviews/:id" element={<ReviewPage />} />
          </Routes>
        </AppShell>
      </BrowserRouter>
    </ServicesProvider>
  </StrictMode>,
);
