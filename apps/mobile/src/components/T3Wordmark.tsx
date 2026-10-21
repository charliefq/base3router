import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

/** B3R wordmark shared visually with the web and desktop sidebar. */
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 104 / 40;
  return (
    <Svg
      accessibilityLabel="B3R"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 104 40"
    >
      <ThemedPath
        d="M4 20H18C31 20 31 4 18 4H4V36H18C31 36 31 20 18 20H4M40 4H55C68 4 68 20 55 20H46M55 20C68 20 68 36 55 36H40M77 36V4H90C103 4 103 20 90 20H77M89 20L101 36"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="none"
        stroke="currentColor"
        strokeWidth={7}
        strokeLinejoin="round"
      />
    </Svg>
  );
}
