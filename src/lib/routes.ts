/** Whether `pathname` is `route` or one of its children. */
export const isRoute = (pathname: string, route: string) =>
  route === "/" ? pathname === "/" : pathname === route || pathname.startsWith(`${route}/`);
