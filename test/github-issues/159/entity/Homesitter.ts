import {Person} from "./Person";
import {ClassEntityChild} from "../../../../src/decorator/entity/ClassEntityChild";
import {Column} from "../../../../src/decorator/columns/Column";

@ClassEntityChild()
export class Homesitter extends Person {

    @Column()
    numberOfKids: number;

}