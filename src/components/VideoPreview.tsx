interface VideoPreviewProps {
  url: string
  filename?: string
}

export function VideoPreview({ url, filename = 'beat-clipper.mp4' }: VideoPreviewProps) {
  return (
    <div className="monitor">
      <div className="monitor__frame">
        <video className="preview__video" src={url} controls autoPlay loop playsInline />
      </div>
      <a className="ctl ctl--primary ctl--lg" href={url} download={filename}>
        Download MP4
      </a>
    </div>
  )
}
