// 메뉴를 불러오는 동안 보여주는 스켈레톤. 빈 화면/텍스트만 있는 로딩보다 체감 대기시간을 줄여준다.
export default function MenuSkeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div className="skeleton-row" key={i} />
      ))}
    </div>
  );
}
