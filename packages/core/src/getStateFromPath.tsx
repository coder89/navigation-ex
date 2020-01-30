import escape from 'escape-string-regexp';
import queryString from 'query-string';
import { NavigationState, PartialState, InitialState } from './types';

type ParseConfig = Record<string, (value: string) => any>;

type Options = {
  [routeName: string]:
    | string
    | {
        path?: string;
        parse?: ParseConfig;
        screens?: Options;
        initialRouteName?: string;
      };
};

type RouteConfig = {
  match: RegExp;
  pattern: string;
  routeNames: string[];
  parse: ParseConfig | undefined;
};

type InitialRouteConfig = {
  initialRouteName: string;
  connectedRoutes: string[];
};

type ResultState = PartialState<NavigationState> & {
  state?: ResultState;
};

/**
 * Utility to parse a path string to initial state object accepted by the container.
 * This is useful for deep linking when we need to handle the incoming URL.
 *
 * Example:
 * ```js
 * getStateFromPath(
 *   '/chat/jane/42',
 *   {
 *     Chat: {
 *       path: 'chat/:author/:id',
 *       parse: { id: Number }
 *     }
 *   }
 * )
 * ```
 * @param path Path string to parse and convert, e.g. /foo/bar?count=42.
 * @param options Extra options to fine-tune how to parse the path.
 */
export default function getStateFromPath(
  path: string,
  options: Options = {}
): ResultState | undefined {
  if (path === '') {
    return undefined;
  }
  let initialRoutes: InitialRouteConfig[] = [];
  // Create a normalized configs array which will be easier to use
  const configs = ([] as RouteConfig[]).concat(
    ...Object.keys(options).map(key =>
      createNormalizedConfigs(key, options, [], initialRoutes)
    )
  );

  let result: PartialState<NavigationState> | undefined;
  let current: PartialState<NavigationState> | undefined;

  let remaining = path
    .replace(/[/]+/, '/') // Replace multiple slash (//) with single ones
    .replace(/^\//, '') // Remove extra leading slash
    .replace(/\?.*/, ''); // Remove query params which we will handle later

  while (remaining) {
    let routeNames: string[] | undefined;
    let params: Record<string, any> | undefined;

    // Go through all configs, and see if the next path segment matches our regex
    for (const config of configs) {
      const match = remaining.match(config.match);

      // If our regex matches, we need to extract params from the path
      if (match) {
        routeNames = [...config.routeNames];

        const paramPatterns = config.pattern
          .split('/')
          .filter(p => p.startsWith(':'));

        if (paramPatterns.length) {
          params = paramPatterns.reduce<Record<string, any>>((acc, p, i) => {
            const key = p.replace(/^:/, '');
            const value = match[i + 1]; // The param segments start from index 1 in the regex match result

            acc[key] =
              config.parse && config.parse[key]
                ? config.parse[key](value)
                : value;

            return acc;
          }, {});
        }

        // Remove the matched segment from the remaining path
        remaining = remaining.replace(match[0], '');

        break;
      }
    }

    // If we hadn't matched any segments earlier, use the path as route name
    if (routeNames === undefined) {
      const segments = remaining.split('/');

      routeNames = [decodeURIComponent(segments[0])];
      segments.shift();
      remaining = segments.join('/');
    }

    let state: InitialState;
    let routeName = routeNames.shift() as string;
    let initialRoute = findInitialRoute(routeName, initialRoutes);

    if (routeNames.length === 0) {
      state = parseRoute(
        initialRoute,
        routeName,
        routeNames.length === 0,
        params
      );
    } else {
      state = parseRoute(initialRoute, routeName, routeNames.length === 0);
      let helper = state.index
        ? (state.routes[state.index].state as InitialState)
        : (state.routes[0].state as InitialState);

      while ((routeName = routeNames.shift())) {
        initialRoute = findInitialRoute(routeName, initialRoutes);
        if (routeNames.length === 0) {
          if (initialRoute) {
            helper.index = 1;
            helper.routes.push(
              { name: initialRoute },
              {
                name: routeName,
                ...(params && { params }),
              }
            );
            console.warn(JSON.stringify(helper));
          } else {
            helper.routes.push({
              name: routeName,
              ...(params && { params }),
            });
          }
        } else {
          if (initialRoute) {
            helper.index = 1;
            helper.routes.push(
              { name: initialRoute },
              {
                name: routeName,
                state: {
                  routes: [],
                },
              }
            );
          } else {
            helper.routes.push({
              name: routeName,
              state: {
                routes: [],
              },
            });
          }

          helper = helper.index
            ? (helper.routes[helper.index].state as InitialState)
            : (helper.routes[0].state as InitialState);
        }
      }
    }

    if (current) {
      // The state should be nested inside the deepest route we parsed before
      while (
        current.index
          ? current.routes[current.index].state
          : current.routes[0].state
      ) {
        current = current?.index
          ? current.routes[current.index].state
          : current.routes[0].state;
      }

      current.routes[0].state = state;
    } else {
      result = state;
    }

    current = state;
  }

  if (current == null || result == null) {
    return undefined;
  }

  const query = path.split('?')[1];

  if (query) {
    while (
      current.index
        ? current.routes[current.index].state
        : current.routes[0].state
    ) {
      // The query params apply to the deepest route
      current = current?.index
        ? current.routes[current.index].state
        : current.routes[0].state;
    }

    const route = current?.index
      ? current.routes[current.index]
      : current.routes[0];

    const params = queryString.parse(query);
    const parseFunction = findParseConfigForRoute(route.name, configs);

    if (parseFunction) {
      Object.keys(params).forEach(name => {
        if (parseFunction[name] && typeof params[name] === 'string') {
          params[name] = parseFunction[name](params[name] as string);
        }
      });
    }

    route.params = { ...route.params, ...params };
  }

  return result;
}

function createNormalizedConfigs(
  key: string,
  routeConfig: Options,
  routeNames: string[] = [],
  initials: InitialRouteConfig[]
): RouteConfig[] {
  const configs: RouteConfig[] = [];

  routeNames.push(key);

  const value = routeConfig[key];

  if (typeof value === 'string') {
    // If a string is specified as the value of the key(e.g. Foo: '/path'), use it as the pattern
    configs.push(createConfigItem(routeNames, value));
  } else if (typeof value === 'object') {
    // if an object is specified as the value (e.g. Foo: { ... }),
    // it has `path` property and
    // it could have `screens` prop which has nested configs
    if (value.initialRouteName) {
      if (!value.screens?.[value.initialRouteName]) {
        throw Error(
          `No such route in ${value}'s config: ${value.initialRouteName}`
        );
      }
      initials.push({
        initialRouteName: value.initialRouteName,
        connectedRoutes: Object.keys(value.screens),
      });
    }
    // navigators can't have `path` property so we don't make it possible to navigate to them
    if (value.path) {
      configs.push(createConfigItem(routeNames, value.path, value.parse));
    }
    if (value.screens) {
      Object.keys(value.screens).forEach(nestedConfig => {
        const result = createNormalizedConfigs(
          nestedConfig,
          value.screens as Options,
          routeNames,
          initials
        );
        configs.push(...result);
      });
    }
  }

  routeNames.pop();

  return configs;
}

function createConfigItem(
  routeNames: string[],
  pattern: string,
  parse?: ParseConfig
): RouteConfig {
  const match = new RegExp(
    '^' + escape(pattern).replace(/:[a-z0-9]+/gi, '([^/]+)') + '/?'
  );

  return {
    match,
    pattern,
    // The routeNames array is mutated, so copy it to keep the current state
    routeNames: [...routeNames],
    parse,
  };
}

function findParseConfigForRoute(
  routeName: string,
  flatConfig: RouteConfig[]
): ParseConfig | undefined {
  for (const config of flatConfig) {
    if (routeName === config.routeNames[config.routeNames.length - 1]) {
      return config.parse;
    }
  }
  return undefined;
}

function findInitialRoute(
  routeName: string,
  initialRoutes: InitialRouteConfig[]
): string | undefined {
  for (const config of initialRoutes) {
    if (config.connectedRoutes.includes(routeName)) {
      return config.initialRouteName === routeName
        ? undefined
        : config.initialRouteName;
    }
  }
  return undefined;
}

function parseRoute(
  initialRoute: string | undefined,
  routeName: string,
  isEmpty: boolean,
  params?: Record<string, any> | undefined
): InitialState {
  if (isEmpty) {
    if (initialRoute) {
      return {
        index: 1,
        routes: [
          { name: initialRoute },
          { name: routeName as string, ...(params && { params }) },
        ],
      };
    } else {
      return {
        routes: [{ name: routeName as string, ...(params && { params }) }],
      };
    }
  } else {
    if (initialRoute) {
      return {
        index: 1,
        routes: [
          { name: initialRoute },
          { name: routeName as string, state: { routes: [] } },
        ],
      };
    } else {
      return {
        routes: [{ name: routeName as string, state: { routes: [] } }],
      };
    }
  }
}
