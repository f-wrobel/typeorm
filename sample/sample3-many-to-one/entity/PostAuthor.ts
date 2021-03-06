import {PrimaryGeneratedColumn, Column, Table, OneToMany} from "../../../src/index";
import {Post} from "./Post";

@Table("sample3_post_author")
export class PostAuthor {

    @PrimaryGeneratedColumn()
    id: number;

    @Column()
    name: string;

    @OneToMany(type => Post, post => post.author)
    posts: Post[];

}