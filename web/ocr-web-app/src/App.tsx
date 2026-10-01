import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent } from 'react'
import * as Tesseract from 'tesseract.js'
import './App.css'

const MAX_DIM = 4000

const LANGS = ['eng', 'hin', 'kan']

const LOAD_PHASES = new Set([
  'loading tesseract core',
  'loading language traineddata',
  'initializing tesseract',
  'initializing api',
])

const SCRIPT_LANGS: Array<{ re: RegExp; lang: string }> = [
  { re: /Devanagari/i, lang: 'hin' },
  { re: /Kannada/i, lang: 'kan' },
]

const detectLangs = async (canvas: HTMLCanvasElement): Promise<string[]> => {
  const det = (await Tesseract.detect(canvas)) as unknown as {
    data?: { script?: string }
  }
  const script = det?.data?.script ?? ''
  const found = SCRIPT_LANGS.filter((s) => s.re.test(script)).map((s) => s.lang)
  return ['eng', ...found.filter((l) => l !== 'eng')]
}

const IMAGE_EXT = /\.(avif|bmp|gif|jpe?g|png|tiff?|webp)$/i

const isImage = (file: File | null | undefined): file is File => {
  return (
    !!file &&
    (file.type.startsWith('image/') || IMAGE_EXT.test(file.name))
  )
}

const imgUrlFromDrop = (dt: DataTransfer): string | undefined => {
  const uriList = dt.getData('text/uri-list')?.trim()
  const uri = uriList?.split('\n').map((l) => l.trim())[0]
  if (uri && /^https?:\/\//i.test(uri)) return uri
  const html = dt.getData('text/html')
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const src = doc.querySelector('img[src]')?.getAttribute('src')
    if (src && /^https?:\/\//i.test(src)) return src
  }
  return undefined
}

const fileFromUrl = async (url: string): Promise<File> => {
  if (url.startsWith('data:')) {
    const [head, b64 = ''] = url.split(',')
    const mime = /^data:([^;,]+)/.exec(head)?.[1] || 'image/png'
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new File([bytes], 'clipboard-image', { type: mime })
  }
  let res: Response
  try {
    res = await fetch(url, { mode: 'cors' })
  } catch (err) {
    throw new Error(
      'url load failed (network or CORS: ' +
        (err instanceof Error ? err.message : String(err)) +
        ')',
    )
  }
  if (!res.ok) throw new Error('url load failed (fetch ' + res.status + ')')
  const ct = res.headers.get('content-type') || ''
  if (ct.startsWith('text/html')) {
    throw new Error('url is a webpage, not a direct image')
  }
  if (!ct.startsWith('image/')) {
    throw new Error('url load failed (not an image)')
  }
  const blob = await res.blob()
  return new File([blob], 'dropped-image', { type: blob.type || 'image/png' })
}

const urlLoadStatus = (err: unknown): string => {
  const msg = err instanceof Error ? err.message : String(err)
  if (msg.includes('webpage, not a direct image')) {
    return `that's a webpage, not a direct image — right-click the image → 'Copy image address'`
  }
  if (msg.startsWith('url load failed')) {
    return "this host blocks cross-site reading\nright-click the image -> 'Copy image' -> Ctrl+V, or Save image -> upload"
  }
  return 'failed: ' + msg
}

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

const wordLang = (text: string): string | null => {
  const votes = new Map<string, number>()
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    let lang: string | null = null
    if (code >= 0x0900 && code <= 0x097f) lang = 'hin'
    else if (code >= 0x0c80 && code <= 0x0cff) lang = 'kan'
    else if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x00c0 && code <= 0x024f)
    )
      lang = 'eng'
    if (lang) votes.set(lang, (votes.get(lang) ?? 0) + 1)
  }
  let best: string | null = null
  let bestN = 0
  votes.forEach((n, lang) => {
    if (n > bestN) {
      bestN = n
      best = lang
    }
  })
  return best
}

const fromHocr = (hocr: string, fallback: string, allowed: Set<string> | null): string => {
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
      .filter((w) => {
        if (!allowed) return true
        const lang = wordLang(w.text)
        return lang === null || allowed.has(lang)
      })
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
  const [hasResult, setHasResult] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [prevUrl, setPrevUrl] = useState<string | null>(null)
  const [imgUrl, setImgUrl] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [langOpen, setLangOpen] = useState(false)
  const [modelStatus, setModelStatus] = useState<string | null>(null)
  const selectedRef = useRef<string[]>([])
  const loadedLangs = useRef<Set<string>>(new Set())
  const lastFile = useRef<File | null>(null)
  const lastLangs = useRef<string[]>([])
  const [busy, setBusy] = useState(false)
  const runRef = useRef<(file: File, langs: string[]) => Promise<void>>(async () => {})

  useEffect(() => {
    selectedRef.current = selected
  })

  useEffect(() => {
    if (!langOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLangOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [langOpen])

  const toggleLang = (lang: string) => {
    const on = selected.includes(lang)
    const next = on ? selected.filter((l) => l !== lang) : [...selected, lang]
    setSelected(next)
    setStatus(next.length ? 'languages: ' + next.join(' + ') : 'languages: auto')
  }

  const langLabel = selected.length ? 'Languages: ' + selected.join(' + ') : 'Languages: auto'

  const onUrl = (e: FormEvent) => {
    e.preventDefault()
    const url = imgUrl.trim()
    if (!/^https?:\/\//i.test(url)) {
      setStatus('enter a valid image URL (starts with http:// or https://)')
      return
    }
    setStatus('fetching image link')
    void fileFromUrl(url)
      .then((f) => run(f, selectedRef.current))
      .catch((err: unknown) => {
        console.error(err)
        setStatus(urlLoadStatus(err))
      })
  }

  const onPaste = (e: ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items)
    const file = items
      .map((i) => i.getAsFile())
      .find((f): f is File => isImage(f))
    if (file) {
      e.preventDefault()
      setStatus('added pasted image')
      void run(file, selectedRef.current)
    } else {
      setStatus('clipboard has no image')
    }
  }

  const run = async (file: File, langs: string[]) => {
    try {
      if (file !== lastFile.current) setHasResult(false)
      lastFile.current = file
      setBusy(true)
      const url = URL.createObjectURL(file)
      if (prevUrl) URL.revokeObjectURL(prevUrl)
      setPrevUrl(url)
      setPreview(url)
      setStatus('loading image')
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('image load failed'))
        el.src = url
      })
      const canvas = upscale(img)
      let effective = langs
      if (!effective.length) {
        setStatus('detecting scripts...')
        try {
          effective = await detectLangs(canvas)
          setStatus('detected: ' + effective.join(' + '))
        } catch (err) {
          console.error(err)
          effective = ['eng']
          setStatus('script detection failed - using eng')
        }
      }
      lastLangs.current = effective
      const missing = effective.filter((l) => !loadedLangs.current.has(l))
      setStatus('loading Tesseract.js worker + ' + effective.join('+'))
      if (missing.length) {
        setModelStatus('loading OCR model data: ' + missing.join(' + '))
      }
      const worker = await Tesseract.createWorker(effective, Tesseract.OEM.LSTM_ONLY, {
        logger: (m) => {
          console.log(m.status, Math.round(m.progress * 100) + '%')
          if (m.status === 'recognizing text') {
            setStatus(m.status + ' ' + Math.round(m.progress * 100) + '%')
          } else if (LOAD_PHASES.has(m.status)) {
            setModelStatus(m.status + ' ' + Math.round(m.progress * 100) + '%')
          }
        },
      })
      missing.forEach((l) => loadedLangs.current.add(l))
      setModelStatus(null)
      try {
        setStatus('pass 1 of 2: PSM SINGLE_BLOCK [' + effective.join('+') + ']')
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
            text: fromHocr(pass1.data.hocr || '', pass1.data.text, langs.length ? new Set(langs) : null),
          },
          {
            label: 'AUTO',
            confidence: pass2.data.confidence,
            text: fromHocr(pass2.data.hocr || '', pass2.data.text, langs.length ? new Set(langs) : null),
          },
        ]
        results.forEach((r) => console.log(r.label, 'conf', r.confidence))
        const winner = results.reduce((a, b) => (b.confidence >= a.confidence ? b : a))
        console.log(winner.label, 'wins')
        console.log(winner.text)
        setText(winner.text)
        setHasResult(true)
        setStatus('done: ' + winner.label + ' conf ' + winner.confidence.toFixed(0) + ' [' + effective.join('+') + ']')
      } finally {
        await worker.terminate()
      }
    } catch (err) {
      console.error(err)
      setStatus('failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }

  const onRerun = () => {
    const file = lastFile.current
    if (!file || busy) return
    const cur = selectedRef.current
    const prev = lastLangs.current
    const key = (a: string[]) => [...a].sort().join('+')
    if (!cur.length && !prev.length) {
      setStatus('re-running auto...')
    } else if (key(cur) === key(prev)) {
      setStatus('re-running [' + cur.join('+') + ']...')
    } else {
      setStatus(
        'language stack changed: [' + (key(prev) || 'auto') + '] -> [' + (key(cur) || 'auto') + ']',
      )
    }
    void run(file, cur)
  }

  useEffect(() => {
    runRef.current = run

    const onDragOver = (e: DragEvent) => {
      e.preventDefault()
    }
    const onDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setDragging(false)
      const dt = e.dataTransfer
      const files = dt?.files
      const file =
        files?.[0] ?? dt?.items?.[0]?.getAsFile() ?? undefined
      if (isImage(file)) {
        setStatus('added dropped image')
        void runRef.current(file, selectedRef.current)
        return
      }
      const url = dt ? imgUrlFromDrop(dt) : undefined
      if (url) {
        setStatus('added dropped image link')
        void fileFromUrl(url)
          .then((f) => runRef.current(f, selectedRef.current))
          .catch((err: unknown) => {
            console.error(err)
            setStatus(urlLoadStatus(err))
          })
        return
      }
      setStatus('not an image drop')
    }
    const onDragEnter = (e: DragEvent) => {
      const types = Array.from(e.dataTransfer?.types ?? [])
      if (types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html')) {
        setDragging(true)
      }
    }
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget) return
      const types = Array.from(e.dataTransfer?.types ?? [])
      if (types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html')) {
        setDragging(false)
      }
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragleave', onDragLeave)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragleave', onDragLeave)
    }
  }, [])

  const [statusMain, ...statusAdvice] = status.split('\n')

  return (
    <main
      className="spike"
      onPaste={onPaste}
    >
      <h1>OCR spike: local image to text</h1>
      <label className="file">
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (isImage(file)) {
              setStatus('added file')
              void run(file, selectedRef.current)
            } else {
              setStatus('not an image file')
            }
          }}
        />
        choose an image
      </label>
      <form className="url" onSubmit={onUrl}>
        <input
          type="text"
          value={imgUrl}
          onChange={(e) => setImgUrl(e.target.value)}
          placeholder="...or paste a direct image URL here"
        />
        <button type="submit">load from URL</button>
      </form>
      <div className="lang">
        <button
          type="button"
          className="lang-toggle"
          onClick={() => setLangOpen((o) => !o)}
        >
          {langLabel} ▾
        </button>
        {langOpen && (
          <div className="lang-panel">
            {LANGS.map((lang) => (
              <label key={lang} className="lang-row">
                <input
                  type="checkbox"
                  checked={selected.includes(lang)}
                  onChange={() => toggleLang(lang)}
                />
                <span className="lang-code">{lang}</span>
              </label>
            ))}
          </div>
        )}
      </div>
      {modelStatus && (
        <p className="modload">
          <span className="spinner" aria-hidden="true" />
          {modelStatus}
        </p>
      )}
      <p className="status">{statusMain}
        {statusAdvice.length > 0 && (
          <>
            <br />
            <span className="status-advice">{statusAdvice.join('\n')}</span>
          </>
        )}
      </p>
      {hasResult && (
        <button type="button" className="rerun" onClick={onRerun} disabled={busy}>
          re-run OCR
        </button>
      )}
      <p className={dragging ? 'hint hint-active' : 'hint'}>
        ...or press Ctrl+V to paste, or drop an image here (file or another tab)
      </p>
      {preview && <img className="preview" src={preview} alt="source image" />}
      <textarea value={text} readOnly rows={10} placeholder="recognized text appears here" />
    </main>
  )
}

export default App