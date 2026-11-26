export interface Preset {
  name: string;
  latex: string;
}

export const PRESETS: Preset[] = [
  { name: "Root of a fraction", latex: String.raw`f(x) = \sqrt{\frac{2x+4}{\sin x - 3}}` },
  { name: "Quadratic formula", latex: String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}` },
  { name: "Euler's identity", latex: String.raw`e^{i\pi} + 1 = 0` },
  { name: "Gaussian integral", latex: String.raw`\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}` },
  { name: "Taylor series", latex: String.raw`f(x) = \sum_{n=0}^{\infty} \frac{f^{(n)}(a)}{n!}(x-a)^n` },
  { name: "Derivative", latex: String.raw`f'(x) = \lim_{h \to 0} \frac{f(x+h) - f(x)}{h}` },
  { name: "Matrix", latex: String.raw`A = \begin{pmatrix} a & b \\ c & d \end{pmatrix}, \quad \det A = ad - bc` },
  { name: "Cases", latex: String.raw`|x| = \begin{cases} x & x \ge 0 \\ -x & x < 0 \end{cases}` },
  { name: "Nested radicals", latex: String.raw`\sqrt[3]{1 + \sqrt{1 + \sqrt{1 + x}}}` },
  { name: "Continued fraction", latex: String.raw`\frac{1}{1 + \frac{1}{1 + \frac{1}{1 + x}}}` },
  { name: "Accents", latex: String.raw`\vec{F} = m\vec{a}, \quad \hat{n} \cdot \bar{v} = \dot{x} + \tilde{y}` },
  { name: "Schrödinger", latex: String.raw`i\hbar \frac{\partial}{\partial t}\Psi(\mathbf{r},t) = \hat{H}\Psi(\mathbf{r},t)` },
  { name: "Growing brackets", latex: String.raw`\left[ \left( \frac{a}{b} \right)^2 + 1 \right] \cdot (x + y)` },
  { name: "Binomial (wrap me)", latex: String.raw`(a+b)^5 = a^5 + 5a^4b + 10a^3b^2 + 10a^2b^3 + 5ab^4 + b^5` },
  { name: "Epsilon–delta", latex: String.raw`\forall \varepsilon > 0\ \exists \delta > 0 : |x - a| < \delta \implies |f(x) - f(a)| < \varepsilon` },
];
