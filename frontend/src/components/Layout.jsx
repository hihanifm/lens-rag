import BottomBar from './BottomBar'

export default function Layout({ children }) {
  return (
    <>
      <div className="pb-8">{children}</div>
      <BottomBar />
    </>
  )
}
