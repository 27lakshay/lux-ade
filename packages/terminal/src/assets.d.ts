// Assets imported through Vite's `?url` suffix: the bundler emits the file and gives its URL.
declare module '*?url' {
  const url: string
  export default url
}

// A file's text, through Vite's `?raw` suffix.
declare module '*?raw' {
  const text: string
  export default text
}
