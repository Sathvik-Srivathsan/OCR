import { useRef, useState } from 'react'
import * as Tesseract from 'tesseract.js'
import './App.css'

const MAX_DIM = 4000

const upscale = (img: HTMLImageElement): HTMLCanvasElement => {
  const max = Math.max(img.naturalWidth, img.naturalHeight)
  const scale = Math.min(2, MAX_DIM / max)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.naturalWidth * scale)
  canvas.height = Math.round(img.naturalHeight * scale)
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  }
  return canvas
}

const medianCharWidth = (words: Array<{ bbox: [number, number, number, number]; text: string }>): number => {
  const widths = words
    .map((w) => (w.bbox[2] - w.bbox[0]) / Math.max(w.text.length, 1))
    .sort((a, b) => a - b)
  return widths.length ? widths[Math.floor(widths.length / 2)] : 0
}

const fromHocr = (hocr: string, fallback: string): string => {
  const doc = new DOMParser().parseFromString(hocr, 'text/html')
  const lines = Array.from(doc.querySelectorAll('.ocr_line'))
  if (!lines.length) return fallback
  const out: string[] = []
  for (const line of lines) {
    const words = Array.from(line.querySelectorAll('.ocrx_word'))
      .map((el) => {
        const nums = (el.getAttribute('title') || '').split(' ').map(Number)
        return {
          bbox: [nums[0], nums[1], nums[2], nums[3]] as [number, number, number, number],
          text: el.textContent || '',
        }
      })
      .filter((w) => w.text.length)
    if (!words.length) continue
    const mw = medianCharWidth(words)
    const parts: string[] = []
    let prevX1 = words[0].bbox[2]
    for (const w of words) {
      if (mw > 0 && w.bbox[0] - prevX1 > mw * 2) parts.push('\t')
      parts.push(w.text)
      prevX1 = w.bbox[2]
    }
    out.push(parts.join(''))
  }
  return out.join('\n')
}

function App() {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState('')
  const [status, setStatus] = useState('waiting for an image')
  const prevUrl = useRef<string | null>(null)

  const run = async (file: File) => {
    const url = URL.createObjectURL(file)
    if (prevUrl.current) URL.revokeObjectURL(prevUrl.current)
    prevUrl.current = url
    setPreview(url)
    setStatus('loading image')
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('image load failed'))
      el.src = url
    })
    const canvas = upscale(img)
    setStatus('loading Tesseract.js worker + eng')
    const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
      logger: (m) => {
        console.log(m.status, Math.round(m.progress * 100) + '%')
        setStatus(m.status + ' ' + Math.round(m.progress * 100) + '%')
      },
    })
    try {
      setStatus('pass 1 of 2: PSM SINGLE_BLOCK')
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
        preserve_interword_spaces: '1',
      })
      const pass1 = await worker.recognize(canvas, {}, { hocr: true })
      setStatus('pass 2 of 2: PSM AUTO')
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.AUTO,
        preserve_interword_spaces: '1',
      })
      const pass2 = await worker.recognize(canvas, {}, { hocr: true })
      const results = [
        {
          label: 'SINGLE_BLOCK',
          confidence: pass1.data.confidence,
          text: fromHocr(pass1.data.hocr || '', pass1.data.text),
        },
        {
          label: 'AUTO',
          confidence: pass2.data.confidence,
          text: fromHocr(pass2.data.hocr || '', pass2.data.text),
        },
      ]
      results.forEach((r) => console.log(r.label, 'conf', r.confidence))
      const winner = results.reduce((a, b) => (b.confidence >= a.confidence ? b : a))
      console.log(winner.label, 'wins')
      console.log(winner.text)
      setText(winner.text)
      setStatus('done: ' + winner.label + ' conf ' + winner.confidence.toFixed(0))
    } finally {
      await worker.terminate()
    }
  }

  return (
    <main className="spike">
      <h1>OCR spike: local image to text</h1>
      <label className="file">
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) run(file)
          }}
        />
        choose an image
      </label>
      <p className="status">{status}</p>
      {preview && <img className="preview" src={preview} alt="source image" />}
      <textarea value={text} readOnly rows={10} placeholder="recognized text appears here" />
    </main>
  )
}

export default App