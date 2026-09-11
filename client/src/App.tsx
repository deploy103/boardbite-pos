import { Routes, Route, Navigate } from "react-router-dom";
import StaffLogin from "./pages/StaffLogin.js";
import AdminHome from "./pages/AdminHome.js";
import FrontHome from "./pages/FrontHome.js";
import CheckoutPage from "./pages/front/CheckoutPage.js";
import PosHome from "./pages/pos/PosHome.js";
import ServingHome from "./pages/serving/ServingHome.js";
import CustomerApp from "./pages/customer/CustomerApp.js";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/staff/login" replace />} />
      <Route path="/staff/login" element={<StaffLogin />} />
      <Route path="/admin" element={<AdminHome />} />
      <Route path="/front" element={<FrontHome />} />
      <Route path="/front/checkout/:tableSessionId" element={<CheckoutPage />} />
      <Route path="/pos" element={<PosHome />} />
      <Route path="/serving" element={<ServingHome />} />
      <Route path="/t/:slug" element={<CustomerApp />} />
      <Route path="*" element={<Navigate to="/staff/login" replace />} />
    </Routes>
  );
}
