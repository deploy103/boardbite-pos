import { Routes, Route, Navigate } from "react-router-dom";
import StaffLogin from "./pages/StaffLogin.js";
import AdminHome from "./pages/AdminHome.js";
import FrontHome from "./pages/FrontHome.js";
import RoleStub from "./pages/RoleStub.js";
import PosHome from "./pages/pos/PosHome.js";
import CustomerApp from "./pages/customer/CustomerApp.js";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/staff/login" replace />} />
      <Route path="/staff/login" element={<StaffLogin />} />
      <Route path="/admin" element={<AdminHome />} />
      <Route path="/front" element={<FrontHome />} />
      <Route path="/pos" element={<PosHome />} />
      <Route path="/serving" element={<RoleStub role="SERVING" note="Phase 4(SERVING)에서 구현 예정입니다." />} />
      <Route path="/t/:slug" element={<CustomerApp />} />
      <Route path="*" element={<Navigate to="/staff/login" replace />} />
    </Routes>
  );
}
