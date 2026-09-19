import { Routes, Route, Navigate } from "react-router-dom";
import StaffLogin from "./pages/StaffLogin.js";
import StaffChangePassword from "./pages/StaffChangePassword.js";
import StaffMfaVerify from "./pages/StaffMfaVerify.js";
import StaffMfaSetup from "./pages/StaffMfaSetup.js";
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
      {/* 온보딩(요구사항2.md §2.4, §2.5.1) — 서버가 이 상태의 계정을 다른 API에서 403으로 막는다. */}
      <Route path="/staff/change-password" element={<StaffChangePassword />} />
      <Route path="/staff/mfa" element={<StaffMfaVerify />} />
      <Route path="/staff/mfa-setup" element={<StaffMfaSetup />} />
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
