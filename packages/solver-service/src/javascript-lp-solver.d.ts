declare module "javascript-lp-solver" {
  type Constraint = { max?: number; min?: number; equal?: number };
  type Model = {
    optimize: string;
    opType: "max" | "min";
    constraints: Record<string, Constraint>;
    variables: Record<string, Record<string, number>>;
    ints?: Record<string, 1>;
  };

  type Result = Record<string, unknown> & {
    feasible?: boolean;
    result?: number;
  };

  const solver: {
    Solve(model: Model): Result;
  };

  export default solver;
}
