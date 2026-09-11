import { useStaffMe } from "../lib/useStaffMe.js";

export default function RoleStub({ role, note }: { role: "POS" | "SERVING"; note: string }) {
  const { me } = useStaffMe(role);
  if (!me) return null;
  return (
    <div className="page">
      <h1>{role === "POS" ? "주방(POS/KDS)" : "서빙(SERVING)"}</h1>
      <p className="text-muted">{note}</p>
    </div>
  );
}
