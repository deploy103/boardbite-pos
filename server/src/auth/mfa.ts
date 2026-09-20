import { prisma } from "../prisma.js";
import { openSecret } from "./secretBox.js";
import { verifyTotpCounter } from "./totp.js";

/**
 * TOTP 1회 소비(요구사항2.md §2.5.1).
 *
 * 검증만 해서는 부족하다 — TOTP는 30초 슬롯마다 같은 6자리가 유효하고 시계 오차 보정으로
 * 앞뒤 1스텝까지 받아주므로, 한 번 노출된 코드가 최대 90초 동안 계속 통한다. 어깨너머로 봤거나
 * 중간에서 가로챈 코드를 그대로 재생(replay)할 수 있다는 뜻이다.
 *
 * 그래서 성공한 슬롯 번호를 계정에 기록하고, 그 이하 슬롯은 다시 받아주지 않는다.
 * 기록은 조건부 update(`mfaLastUsedCounter < counter`)로 하므로, 같은 코드를 동시에 두 번
 * 보내는 경쟁 상황에서도 한쪽만 성공한다.
 *
 * @returns 소비에 성공하면 true. 코드가 틀렸거나 이미 사용된 슬롯이면 false.
 */
export async function consumeTotp(
  user: { id: string; mfaSecretEncrypted: string | null; mfaLastUsedCounter: number | null },
  token: string,
): Promise<boolean> {
  if (!user.mfaSecretEncrypted) return false;

  const secret = openSecret(user.mfaSecretEncrypted);
  if (!secret) return false;

  const counter = verifyTotpCounter(secret, token);
  if (counter === null) return false;

  // 이미 쓴 슬롯(또는 그 이전)이면 재사용이다.
  if (user.mfaLastUsedCounter !== null && counter <= user.mfaLastUsedCounter) return false;

  const claimed = await prisma.staffUser.updateMany({
    where: {
      id: user.id,
      OR: [{ mfaLastUsedCounter: null }, { mfaLastUsedCounter: { lt: counter } }],
    },
    data: { mfaLastUsedCounter: counter },
  });

  // 0이면 그 사이 같은(또는 더 최신) 슬롯이 이미 소비된 것 — 동시 재생 시도로 본다.
  return claimed.count === 1;
}
