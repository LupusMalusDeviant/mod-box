// Package Guard: names that look like a well-known package but are not it (typosquatting). No $.
import type { Ecosystem } from './parse'

// Well-known packages per ecosystem: the names a typo would aim at.
export const POPULAR: Record<Ecosystem, string[]> = {
  npm: [
    'react', 'react-dom', 'next', 'vue', 'nuxt', 'svelte', 'angular', 'express', 'koa', 'fastify', 'hono', 'lodash', 'underscore', 'axios', 'node-fetch',
    'request', 'chalk', 'commander', 'yargs', 'inquirer', 'debug', 'dotenv', 'cross-env', 'rimraf', 'glob', 'minimist', 'moment', 'dayjs', 'date-fns',
    'uuid', 'nanoid', 'classnames', 'clsx', 'typescript', 'ts-node', 'tsx', 'esbuild', 'vite', 'webpack', 'rollup', 'parcel', 'babel-core', 'eslint',
    'prettier', 'jest', 'vitest', 'mocha', 'chai', 'sinon', 'cypress', 'playwright', 'puppeteer', 'electron', 'socket.io', 'ws', 'mongoose', 'mongodb',
    'mysql', 'mysql2', 'pg', 'sqlite3', 'better-sqlite3', 'redis', 'ioredis', 'prisma', 'sequelize', 'typeorm', 'knex', 'zod', 'yup', 'joi', 'ajv',
    'jsonwebtoken', 'bcrypt', 'bcryptjs', 'passport', 'cors', 'helmet', 'body-parser', 'cookie-parser', 'multer', 'morgan', 'winston', 'pino',
    'nodemon', 'concurrently', 'husky', 'lint-staged', 'tailwindcss', 'postcss', 'autoprefixer', 'sass', 'less', 'styled-components', 'redux',
    'zustand', 'mobx', 'rxjs', 'graphql', 'apollo-server', 'openai', 'anthropic', 'langchain', 'three', 'd3', 'chart.js', 'jquery', 'bootstrap',
    'semver', 'colors', 'ora', 'execa', 'fs-extra', 'chokidar', 'got', 'superagent', 'cheerio', 'jsdom', 'sharp', 'jimp', 'marked', 'markdown-it',
    'highlight.js', 'prismjs', 'shelljs', 'js-yaml', 'yaml', 'xml2js', 'qs', 'ramda', 'immer', 'async', 'bluebird', 'core-js', 'tslib',
  ],
  pypi: [
    'requests', 'urllib3', 'numpy', 'pandas', 'scipy', 'matplotlib', 'seaborn', 'scikit-learn', 'tensorflow', 'torch', 'keras', 'transformers',
    'flask', 'django', 'fastapi', 'uvicorn', 'gunicorn', 'starlette', 'pydantic', 'sqlalchemy', 'psycopg2', 'psycopg2-binary', 'pymysql', 'redis',
    'celery', 'boto3', 'botocore', 'awscli', 'setuptools', 'wheel', 'pip', 'virtualenv', 'pytest', 'tox', 'black', 'flake8', 'pylint', 'mypy',
    'isort', 'ruff', 'click', 'typer', 'rich', 'colorama', 'tqdm', 'pyyaml', 'toml', 'python-dotenv', 'jinja2', 'markupsafe', 'beautifulsoup4',
    'lxml', 'selenium', 'playwright', 'scrapy', 'httpx', 'aiohttp', 'pillow', 'opencv-python', 'cryptography', 'pyjwt', 'paramiko', 'openai',
    'anthropic', 'langchain', 'jupyter', 'ipython', 'notebook', 'pyinstaller', 'six', 'attrs', 'certifi', 'idna', 'charset-normalizer', 'pytz',
    'python-dateutil', 'docker', 'kubernetes', 'grpcio', 'protobuf', 'networkx', 'sympy', 'nltk', 'spacy', 'gensim', 'xgboost', 'lightgbm',
  ],
  crates: [
    'serde', 'serde_json', 'serde_derive', 'tokio', 'async-std', 'futures', 'reqwest', 'hyper', 'axum', 'actix-web', 'warp', 'rocket', 'clap',
    'structopt', 'anyhow', 'thiserror', 'log', 'env_logger', 'tracing', 'tracing-subscriber', 'rand', 'regex', 'lazy_static', 'once_cell',
    'chrono', 'time', 'uuid', 'itertools', 'rayon', 'crossbeam', 'parking_lot', 'bytes', 'base64', 'sha2', 'md5', 'ring', 'rustls', 'openssl',
    'diesel', 'sqlx', 'rusqlite', 'redis', 'tonic', 'prost', 'syn', 'quote', 'proc-macro2', 'bitflags', 'libc', 'winapi', 'windows', 'nix',
    'toml', 'serde_yaml', 'url', 'image', 'wgpu', 'bevy', 'egui', 'tauri', 'indicatif', 'dirs', 'walkdir', 'tempfile', 'num', 'nalgebra',
  ],
}

/** Edit distance with transpositions (Damerau-Levenshtein, optimal string alignment). */
export function distance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1)
      d[i]![j] = v
    }
  }
  return d[a.length]![b.length]!
}

const squash = (s: string) => s.replace(/^@[^/]+\//, '').replace(/[-_.]/g, '')

/** The well-known package this name looks like (but is not), or null. */
export function lookalike(eco: Ecosystem, name: string): string | null {
  const list = POPULAR[eco]
  if (list.includes(name)) return null
  for (const known of list) {
    // react-dom vs reactdom, python_dotenv vs python-dotenv
    if (squash(known) === squash(name)) return known
    const max = known.length >= 8 ? 2 : known.length >= 4 ? 1 : 0
    if (max && Math.abs(known.length - name.length) <= max && distance(known, name) <= max) return known
  }
  return null
}
